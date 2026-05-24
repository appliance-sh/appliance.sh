# Architecture

Technical reference for Appliance internals, API, and infrastructure.

## Packages

Appliance is a TypeScript monorepo (pnpm workspaces + Nx) with 5 packages:

| Package                       | Description                                               |
| ----------------------------- | --------------------------------------------------------- |
| **@appliance.sh/sdk**         | Core SDK — Zod models, API client, storage abstraction    |
| **@appliance.sh/cli**         | CLI built on Commander.js + Inquirer                      |
| **@appliance.sh/api-server**  | Express REST API server (control plane)                   |
| **@appliance.sh/infra**       | Pulumi infrastructure-as-code for AWS                     |
| **@appliance.sh/install-aws** | AWS CDK stack for bootstrapping Appliance on your account |

### Dependencies

```
api-server → infra → sdk
cli → sdk
install-aws → sdk
```

### Build Outputs

- **SDK**: `dist/cjs/` (CommonJS), `dist/esm/` (ESM), `dist/types/` (TypeScript declarations)
- **All others**: `dist/`
- **install-aws**: `dist/appliance-install-aws.yml` (CloudFormation template)

## Data Models

All models are defined as Zod schemas in `packages/sdk/src/models/`.

### Project

```typescript
{ id, name, description?, status: 'active' | 'archived', createdAt, updatedAt }
```

### Environment

```typescript
{ id, projectId, name,
  status: 'pending' | 'deploying' | 'deployed' | 'destroying' | 'destroyed' | 'failed',
  baseConfig: ApplianceBaseConfig, stackName, lastDeployedAt?, createdAt, updatedAt }
```

### Deployment

```typescript
{ id, projectId, environmentId, action: 'deploy' | 'destroy',
  status: 'pending' | 'in_progress' | 'succeeded' | 'failed',
  startedAt, completedAt?, message?, idempotentNoop?,
  workerInvokedAt?, workerCompletedAt? }
```

### ApiKey

```typescript
{ id, secretHash, name, createdAt, lastUsedAt? }
```

### Appliance (discriminated union by `type`)

- **container**: `{ manifest: 'v1', type: 'container', name, port, platform?, scripts? }`
- **framework**: `{ manifest: 'v1', type: 'framework', name, framework?: 'auto' | 'python' | 'node' | 'other', port?, includes?, excludes?, scripts? }`
- **other**: `{ manifest: 'v1', type: 'other', name, scripts? }`

### ApplianceBase (discriminated union by `type`)

- **aws-public**: `{ type: 'appliance-base-aws-public', name, region, dns: { domainName, createZone?, attachZone? } }`
- **aws-vpc**: `{ type: 'appliance-base-aws-vpc', name, region, dns, vpc: { vpcCidr?, numberOfAzs? } | { vpcId } }`
- **local**: `{ type: 'appliance-base-local', name, cluster?: { clusterName?, namespace?, hostPort? } }` — k3d-backed local runtime; no DNS, no region. Persisted form carries a `local.dataDir` for the filesystem object store.

## API Reference

The API server runs on port 3000 by default (`PORT` env var). All `/api/v1/*` endpoints require authentication.

### Bootstrap (No Auth)

| Method | Path                    | Description                                                  |
| ------ | ----------------------- | ------------------------------------------------------------ |
| `GET`  | `/bootstrap/status`     | Check if any API keys exist                                  |
| `POST` | `/bootstrap/create-key` | Create initial API key (requires `X-Bootstrap-Token` header) |

Create the first API key:

```bash
curl -X POST http://localhost:3000/bootstrap/create-key \
  -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-key"}'
```

Returns an access key ID (`ak_...`) and secret (`sk_...`). The secret is shown only once.

### Projects

| Method   | Path                   | Description    |
| -------- | ---------------------- | -------------- |
| `POST`   | `/api/v1/projects`     | Create project |
| `GET`    | `/api/v1/projects`     | List projects  |
| `GET`    | `/api/v1/projects/:id` | Get project    |
| `DELETE` | `/api/v1/projects/:id` | Delete project |

### Environments

| Method   | Path                                           | Description        |
| -------- | ---------------------------------------------- | ------------------ |
| `POST`   | `/api/v1/projects/:projectId/environments`     | Create environment |
| `GET`    | `/api/v1/projects/:projectId/environments`     | List environments  |
| `GET`    | `/api/v1/projects/:projectId/environments/:id` | Get environment    |
| `DELETE` | `/api/v1/projects/:projectId/environments/:id` | Delete environment |

### Deployments

| Method | Path                      | Description                                            |
| ------ | ------------------------- | ------------------------------------------------------ | ------------- |
| `POST` | `/api/v1/deployments`     | Start a deployment (`{ environmentId, action: 'deploy' | 'destroy' }`) |
| `GET`  | `/api/v1/deployments/:id` | Get deployment status                                  |

### Builds

| Method | Path                 | Description      |
| ------ | -------------------- | ---------------- |
| `POST` | `/api/v1/builds`     | Create a build   |
| `GET`  | `/api/v1/builds/:id` | Get build status |

## Authentication

API authentication uses HTTP Message Signatures ([RFC 9421](https://www.rfc-editor.org/rfc/rfc9421)). The CLI and SDK handle signing automatically.

Signed components: request method, path, authority, content-digest, content-type.

API key pairs consist of:

- **Access Key ID** (`ak_...`) — identifies the key
- **Secret Access Key** (`sk_...`) — used for signing, hashed with SHA-256 before storage

Validation uses `crypto.timingSafeEqual()` to prevent timing attacks. Credentials are stored locally at `~/.appliance/credentials.json` with mode `0600`.

## Infrastructure

### AWS (aws-public)

The current deployment target provisions:

- **CloudFront** distribution for edge caching and HTTPS termination
- **Lambda Function URL** for running the application
- **Lambda@Edge** for SigV4-signed origin requests
- **Route53** for DNS management
- **ACM** for TLS certificates

Infrastructure is managed via Pulumi (`packages/infra/src/lib/aws/`). Key components:

- `ApplianceStack` — per-environment Lambda + optional CloudFront
- `ApplianceBaseAwsPublic` — shared base: CloudFront + Lambda@Edge + Route53 + ACM
- `ApplianceDeploymentService` — wraps Pulumi Automation API for deploy/destroy
- `edge-router.ts` — Lambda@Edge function for SigV4 signing

### Deployment Flow

Deployments are asynchronous:

1. `POST /api/v1/deployments` writes a pending deployment record to S3
2. A detached worker process (`deployment.worker.ts`) is spawned
3. The API returns immediately with `status: pending`
4. The worker executes Pulumi and updates status to `succeeded` or `failed`
5. Clients poll `GET /api/v1/deployments/:id` for progress

Only one deployment can be active per environment at a time. Deployments are idempotent — if no changes are needed, the result is a no-op.

### Storage

All state is stored via the `ObjectStore` interface (`get`, `set`, `delete`, `list`). Two implementations are available:

- **S3ObjectStore** (cloud bases) — backed by the cluster's data bucket; also where Pulumi state lives.
- **FilesystemObjectStore** (local base) — backed by `local.dataDir` from the base config; no S3, no Pulumi state.

The api-server picks the implementation at startup based on `APPLIANCE_BASE_CONFIG.type`.

### Local Kubernetes runtime

The `appliance-base-local` base swaps the cloud control plane for a k3d cluster running on the developer's machine:

| Cloud component              | Local equivalent                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| S3 object store              | `FilesystemObjectStore` rooted at `local.dataDir`                                         |
| ECR image push (via `crane`) | `k3d image import` from the host Docker daemon                                            |
| Pulumi-driven Lambda deploy  | `kubectl apply` of a Deployment + NodePort Service per appliance                          |
| Lambda execution role        | k8s ServiceAccount (default)                                                              |
| CloudFront / Route53         | k3d serverlb hairpins `host_port:80@loadbalancer` so services are reachable from the host |
| Pulumi cancel / refresh      | No-op (kubectl-driven, the cluster state IS the source of truth)                          |

The `LocalContainerDeploymentService` in `@appliance.sh/infra/lib/local/` provides the same `deploy / destroy / refresh` surface as `ApplianceDeploymentService`. The api-server's `deployment-executor.service.ts` selects between them at run time based on `baseConfig.type`.

Cluster lifecycle (`start_local_cluster`, `stop_local_cluster`, `delete_local_cluster`, `local_cluster_status`) is exposed to the desktop UI via Tauri commands in `packages/desktop/src-tauri/src/lib.rs` and surfaced in TypeScript as the optional `ConsoleHost.local` field. On macOS, the k3d nodes run inside the Docker Desktop / Colima micro-VM — that's the "underlying micro VM" layer the desktop orchestrates.

### Installing Appliance on AWS

The `install-aws` package provides an AWS CDK construct (`ApplianceInstaller`) that bootstraps the required S3 bucket and IAM roles. It outputs a CloudFormation template at `dist/appliance-install-aws.yml`.

## Environment Variables

| Variable                | Description                                       | Default |
| ----------------------- | ------------------------------------------------- | ------- |
| `PORT`                  | API server port                                   | `3000`  |
| `BOOTSTRAP_TOKEN`       | Token for initial API key creation                | —       |
| `APPLIANCE_BASE_CONFIG` | JSON string with ApplianceBase config             | —       |
| `AWS_REGION`            | Target AWS region                                 | —       |
| `PULUMI_BACKEND_URL`    | S3 URL for Pulumi state (e.g. `s3://bucket-name`) | —       |

## Development

### Setup

```bash
pnpm install
pnpm run dev:setup    # Workspace linking is automatic with pnpm
pnpm run dev          # API server in watch mode + SDK/infra rebuilds
pnpm run build        # Build all packages
```

### Testing

Tests use Vitest (`packages/api-server/src/**/*.spec.ts`):

```bash
pnpm --filter @appliance.sh/api-server run test
pnpm --filter @appliance.sh/api-server run test:watch
pnpm --filter @appliance.sh/api-server run test:cov
```

### Linting

```bash
pnpm run lint:check    # Check for issues
pnpm run lint:fix      # Auto-fix issues
```

Prettier: single quotes, trailing commas (es5), 2-space indent, 120 char line width. Pre-commit hook runs ESLint + Prettier via lint-staged.

### Releasing

Uses Nx with conventional commits:

```bash
pnpm run release       # Interactive
pnpm run release:ci    # Non-interactive (CI)
```
