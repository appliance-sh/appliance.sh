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
- **local**: `{ type: 'appliance-base-local', name, cluster?: { clusterName?, namespace?, hostPort?, hostnameSuffix?, ingressClassName? } }` — desktop-managed k3d runtime; no DNS, no region. Persisted form carries a `local.dataDir` for the filesystem object store.
- **kubernetes**: `{ type: 'appliance-base-kubernetes', name, kubernetes: { server?, ca?, token?, kubeconfig?, namespace?, hostnameSuffix?, ingressClassName?, hostPort?, dataDir, registry? } }` — generic BYO Kubernetes cluster reachable via URL + credentials (or an inline kubeconfig, or in-cluster ServiceAccount when api-server is itself in the cluster). `hostPort` is the host-side ingress/LB port used when composing reported deploy URLs (defaults to 80).

Both `local` and `kubernetes` are handled by the same `KubernetesDeploymentService` under the hood. Use the helper `isKubernetesBase(config)` (exported from `@appliance.sh/sdk`) to branch on "is this a k8s-driven base" rather than enumerating the two variants explicitly.

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

### Kubernetes runtime

Two base variants drive deploys against a Kubernetes cluster instead of AWS:

- **`appliance-base-local`** — desktop-managed k3d cluster on the developer's machine. The desktop owns cluster lifecycle (start/stop/delete) and pre-flight (Docker, k3d, kubectl).
- **`appliance-base-kubernetes`** — generic BYO cluster reachable via URL + credentials. The same machinery, but cluster lifecycle and credential provisioning are out of band.

Both variants flow through `KubernetesDeploymentService` (`@appliance.sh/infra/lib/local/`), which talks to the cluster via `@kubernetes/client-node` rather than shelling out to `kubectl`. Each appliance maps to a Deployment + Service (NodePort) + Ingress in the configured namespace; destroy tears the same trio down.

| Cloud component              | Kubernetes equivalent                                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| S3 object store              | `FilesystemObjectStore` rooted at `kubernetes.dataDir` (PVC-mounted in-cluster, host-path on local k3d)           |
| ECR image push (via `crane`) | `docker push` to a cluster-attached registry (k3d local) or to any reachable registry (generic kubernetes)        |
| Pulumi-driven Lambda deploy  | k8s API `apply` (read → create-or-replace) of a Deployment + Service + Ingress per appliance                      |
| Lambda execution role        | k8s ServiceAccount (default)                                                                                      |
| CloudFront / Route53         | Cluster Ingress (Traefik on k3d) at `<stack>.<hostnameSuffix>` — defaults to `*.appliance.localhost` on local k3d |
| Pulumi cancel / refresh      | No-op — the k8s API state IS the source of truth                                                                  |

#### Cluster connection

`KubernetesDeploymentService` resolves a `KubeConfig` in this priority order:

1. `appliance-base-kubernetes` with inline `kubernetes.kubeconfig` (YAML).
2. `appliance-base-kubernetes` with `kubernetes.server` + `kubernetes.token` (+ optional `ca`).
3. `appliance-base-kubernetes` with nothing set — `kc.loadFromCluster()` reads the mounted ServiceAccount (the path taken when api-server itself runs in-cluster).
4. `appliance-base-local` — falls back to the host's default kubeconfig (preserves prior k3d-on-laptop behavior).

#### Deploying to a Kubernetes base

Kubernetes-driven api-servers reject upload-flow builds (the in-cluster api-server has no docker daemon to build with) — deploys reference **container images** instead. `appliance deploy` detects the base type via `GET /api/v1/cluster-info` and switches pipeline automatically:

1. `docker build` the appliance directory (container-type manifests only — framework apps need a Dockerfile to deploy locally).
2. Push to the cluster-attached registry (`kubernetes.registry.url`) when one exists, and best-effort `k3d image import` the same ref — the import makes deploys independent of registry-mirror configuration (`--registry-use` only takes effect at cluster create, so older clusters lack the mirror).
3. Register a `remote-image` build (`POST /api/v1/builds` with `{ type: 'remote-image', uploadUrl, port }`). The declared `port` rides on the build record and becomes the k8s Service target port — remote images carry no manifest to read it from.

Reported deploy URLs are composed as `http://<stack>.<hostnameSuffix>[:<hostPort>]`; `kubernetes.hostPort` declares the host-side port the cluster's ingress/LB answers on (8081 for the managed k3d runtime, defaults to 80 for directly-routable clusters).

#### In-cluster api-server

api-server runs as a Kubernetes Deployment inside the cluster it manages — mirroring the AWS path where api-server is itself a deployed appliance. The bootstrap (desktop: `bootstrap_in_cluster_api_server` Tauri command; CLI: `bootstrapInClusterApiServer` in `@appliance.sh/helper`) applies the manifests (Deployment + Service + Ingress + ServiceAccount + ClusterRole(Binding) + Secret + PVC) into the `appliance-system` namespace, waits for the Ingress at `api.appliance.localhost` to be reachable, and mints the first API key via the bootstrap token.

The in-cluster api-server image defaults to `ghcr.io/appliance-sh/api-server:latest`. For local iteration, build the image (`packages/api-server/scripts/docker-prep.sh`), push it to the cluster registry (`localhost:5050/appliance-api-server:<tag>`), then pass that ref through `BootstrapInClusterInput.image` / `appliance local up --image`.

#### Local cluster lifecycle (k3d)

Cluster lifecycle is a host-OS concern that doesn't fit in api-server. The shared implementation lives in `@appliance.sh/helper` (`cluster.ts`, `runtime.ts`, `api-server.ts`) and is exposed two ways: the CLI's `appliance local` commands and the desktop's Tauri commands (`packages/desktop/src-tauri/src/lib.rs`, an earlier Rust port of the same flows — keep the two in sync until the desktop delegates to the sidecar).

- `appliance local up` / `start_local_runtime` — brings the runtime daemon up (auto-starting colima when it's the active runtime), creates-or-starts the k3d cluster with a sibling registry (`<cluster>-registry` on host port 5050, attached via `--registry-use`), publishes the serverlb on the configured host port, bootstraps the in-cluster api-server, and saves credentials (CLI: the `local-runtime` profile; desktop: persisted cluster registry).
- `appliance local stop` / `stop_local_cluster` — stops the cluster without deleting state.
- `appliance local delete` / `delete_local_cluster` — confirm-gated teardown; also removes the matching registry. The host data dir survives.
- `appliance local status` / `local_preflight` + `local_cluster_status` — tool checks (docker/k3d/kubectl), daemon reachability, cluster existence/running state, api-server reachability.
- `appliance local runtime start` / `start_container_runtime` — starts the container runtime when appliance can do so safely.

Two robustness behaviors live in the shared cluster module:

- **Node-readiness gate**: container-level "running" doesn't imply usable — after the Docker VM restarts underneath a cluster, kubelets can come back wedged (`kubectl get nodes` shows NotReady forever, pods sit Pending). `startLocalCluster` waits for every node to report Ready and recovers once with a full stop/start before failing.
- **colima auto-start**: the docker provider is install-detect-only, but a _stopped_ runtime is auto-started when (and only when) the docker CLI is wired to colima (`docker context show` == `colima` or `DOCKER_HOST` points at its socket). GUI runtimes (Docker Desktop, OrbStack) and system dockerd get actionable guidance instead.

On macOS, the k3d nodes and the registry both run inside the Docker Desktop / Colima micro-VM — that's the "underlying micro VM" layer the lifecycle commands orchestrate.

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

### Desktop UI in a browser (mock host)

The desktop-only pages (Local Runtime, deploy wizard, bootstrap) normally need a Tauri build. For UI iteration, a dev-only mock of the Tauri IPC layer lets them run in any browser:

```bash
pnpm --filter @appliance.sh/desktop dev
# then open http://localhost:1420/?mock-host&scenario=<name>
```

Scenarios (`packages/desktop/src/mock-host.ts`): `ready` (default), `running` (workloads populated), `daemon-down` (colima stopped, auto-startable), `daemon-manual`, `missing` (tools not installed). Lifecycle transitions are simulated with realistic delays; SDK-driven pages can talk to a real api-server by patching the mock cluster's key in sessionStorage. The mock is loaded via dynamic import behind `import.meta.env.DEV` — it never ships in production bundles.

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
