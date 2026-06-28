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
- **local** _(deprecated)_: `{ type: 'appliance-base-local', name, cluster?: { clusterName?, namespace?, hostPort?, hostnameSuffix?, ingressClassName? } }` — the former host-side k3d runtime. Removed; the enum value & schema are retained only so deploys created before the cutover still parse. New local deploys use the microVM, which is an `appliance-base-kubernetes` base under the hood.
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

- **`appliance-base-kubernetes`** — generic Kubernetes cluster reachable via URL + credentials (or an inline kubeconfig, or in-cluster ServiceAccount). Covers both BYO clusters and the **microVM local runtime** (`appliance vm up`), which is an `appliance-base-kubernetes` cluster under the hood.
- **`appliance-base-local`** _(deprecated)_ — the former host-side k3d runtime. Removed; the type is retained only so deploys created before the cutover still parse.

Both variants flow through `KubernetesDeploymentService` (`@appliance.sh/infra/lib/local/`), which talks to the cluster via `@kubernetes/client-node` rather than shelling out to `kubectl`. Each appliance maps to a Deployment + Service (NodePort) + Ingress in the configured namespace; destroy tears the same trio down.

| Cloud component              | Kubernetes equivalent                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| S3 object store              | `FilesystemObjectStore` rooted at `kubernetes.dataDir` (PVC-mounted in-cluster)                              |
| ECR image push (via `crane`) | `docker push` to the runtime's image registry (the microVM's in-VM registry, or any reachable registry)      |
| Pulumi-driven Lambda deploy  | k8s API `apply` (read → create-or-replace) of a Deployment + Service + Ingress per appliance                 |
| Lambda execution role        | k8s ServiceAccount (default)                                                                                 |
| CloudFront / Route53         | Cluster Ingress (Traefik) at `<stack>.<hostnameSuffix>` — defaults to `*.appliance.localhost` on the microVM |
| Pulumi cancel / refresh      | No-op — the k8s API state IS the source of truth                                                             |

#### Cluster connection

`KubernetesDeploymentService` resolves a `KubeConfig` in this priority order:

1. `appliance-base-kubernetes` with inline `kubernetes.kubeconfig` (YAML).
2. `appliance-base-kubernetes` with `kubernetes.server` + `kubernetes.token` (+ optional `ca`).
3. `appliance-base-kubernetes` with nothing set — `kc.loadFromCluster()` reads the mounted ServiceAccount (the path taken when api-server itself runs in-cluster).
4. `appliance-base-local` _(deprecated)_ — falls back to the host's default kubeconfig.

#### Deploying to a Kubernetes base

Kubernetes-driven api-servers reject upload-flow builds (the in-cluster api-server has no docker daemon to build with) — deploys reference **container images** instead. `appliance deploy` detects the base type via `GET /api/v1/cluster-info` and switches pipeline automatically:

1. `docker build` the appliance directory (container-type manifests only — framework apps need a Dockerfile to deploy locally).
2. Push the image to the runtime's image registry (`kubernetes.registry.url`) — the microVM's in-VM registry, or any registry a BYO cluster can reach. Image delivery is **registry-only**; there is no host-side image-import fallback.
3. Register a `remote-image` build (`POST /api/v1/builds` with `{ type: 'remote-image', uploadUrl, port }`). The declared `port` rides on the build record and becomes the k8s Service target port — remote images carry no manifest to read it from.

Reported deploy URLs are composed as `http://<stack>.<hostnameSuffix>[:<hostPort>]`; `kubernetes.hostPort` declares the host-side port the cluster's ingress/LB answers on (8081 for the microVM runtime, defaults to 80 for directly-routable clusters).

#### In-cluster api-server

api-server runs as a Kubernetes Deployment inside the cluster it manages — mirroring the AWS path where api-server is itself a deployed appliance. The bootstrap (desktop: `bootstrap_in_cluster_api_server` Tauri command; CLI: `bootstrapInClusterApiServer` in `@appliance.sh/helper`) applies the manifests (Deployment + Service + Ingress + ServiceAccount + ClusterRole(Binding) + Secret + PVC) into the `appliance-system` namespace, waits for the Ingress at `api.appliance.localhost` to be reachable, and mints the first API key via the bootstrap token.

The in-cluster api-server image defaults to `ghcr.io/appliance-sh/api-server:latest`. For local iteration, build the image (`packages/api-server/scripts/docker-prep.sh`), push it to the runtime's registry (`localhost:5052/appliance-api-server:<tag>` for the microVM), then pass that ref through `BootstrapInClusterOptions.image` / `appliance vm up --image`.

#### MicroVM engine (the local runtime)

The local runtime boots an isolated VM that Appliance owns end-to-end
(`packages/vm`, design in `docs/microvm.md`): direct kernel boot via the
platform hypervisor (Virtualization.framework on macOS; KVM/WSL2
scaffolded), k3s on containerd inside, an in-VM image registry, and
host-side TCP forwards that preserve the exact
`*.appliance.localhost:8081` URL surface. `appliance vm up` boots it,
bootstraps the in-VM api-server, and registers the `microvm` profile;
`appliance deploy --profile microvm` then works verbatim. It is the sole
local runtime — the former host-side k3d engine has been removed (macOS /
Virtualization.framework is supported today; Linux/Windows wait on the
KVM/WSL2 backend, with no k3d fallback in the interim). The desktop
presents it as the single **Local runtime**, set up by a one-press
first-run prompt.

Because the local cluster runs the host's architecture and can't emulate
(no binfmt in the microVM), every host-side image delivery targets the
host arch: the api-server image is extracted with
`docker save --platform linux/<host>` (works for single- or multi-arch
images, fails fast otherwise), and app-image builds are pinned to the
host arch regardless of the manifest's `platform` — a cross-arch image
would otherwise crashloop with `exec format error`.

Lifecycle (boot / stop / delete) belongs to the `appliance vm` commands
and the desktop's microVM Tauri commands, driving the `appliance-vm` Rust
binary in `packages/vm`. The shared in-cluster api-server bootstrap lives
in `@appliance.sh/helper` (`api-server.ts`).

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
