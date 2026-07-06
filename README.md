# Appliance

A platform for installing and running applications on the cloud. Define your app in a manifest, run one command, and Appliance handles packaging, infrastructure, and routing.

## Getting Started

### 1. Install the CLI

```bash
pnpm add --global appliance.sh
appliance --version
```

### 2. Create an application manifest

Create an `appliance.json` in your project directory. You can do this interactively with `appliance configure`, or write one directly:

**Node.js app:**

```json
{
  "manifest": "v1",
  "type": "framework",
  "name": "my-app",
  "framework": "node"
}
```

**Python app:**

```json
{
  "manifest": "v1",
  "type": "framework",
  "name": "my-app",
  "framework": "python"
}
```

**Docker container:**

```json
{
  "manifest": "v1",
  "type": "container",
  "name": "my-app",
  "port": 3000
}
```

### 3. Deploy

```bash
appliance login       # Authenticate with your Appliance server
appliance setup       # Link this folder to a project/environment (one-time)
appliance deploy      # Build, upload, and deploy
```

`appliance setup` writes a `.appliance/link.json` recording which project and environment this folder targets. After linking, `appliance deploy` (with no arguments) builds the manifest, uploads it, and rolls the linked environment forward — re-deploys are a single command.

If no `appliance.zip` exists, `appliance deploy` builds one automatically. On a first deploy without `setup`, you can still pass `appliance deploy <project> <environment>` explicitly; the CLI will create both as needed and record the link.

The CLI polls until the deployment completes and prints the deployed URL when one is available. Check status anytime with `appliance status` (defaults to the linked project) or `appliance deployment status <deployment-id>`. Open the running app with `appliance open`.

## Web console & inviting your team

The api-server serves the web console itself: the server URL printed by `appliance bootstrap` **is** the console URL — open it in a browser. No separate hosting, no CORS setup.

To onboard a teammate (including non-technical ones), open the console → **Settings → Team** → type their name → **Create invite link**, and send them the link. Opening it signs them in with their own credential — no server URL or secret to paste, and it persists across browser restarts. Invite links are single-use and expire (7 days by default). The same Team panel lists everyone with access and revokes it in one click.

Invited teammates get a **member** key: they see and manage apps (deploy status, redeploys, environment variables) but not the operator surfaces (clusters, bootstrap, agents, key management). Keys created via `appliance bootstrap` / `appliance login` are **admins** with the full console.

Console-serving is configurable on the server for hardened deployments:

- `APPLIANCE_CONSOLE_MODE` — `full` (default), `bootstrap` (this origin only handles onboarding/invite redemption and points users at the hardened console), or `off` (API only).
- `APPLIANCE_CONSOLE_URL` — canonical console URL when you host the console elsewhere (e.g. behind a VPN or SSO proxy). Invite links target it, and its origin is automatically CORS-allowed.
- `APPLIANCE_CONSOLE_DIR` — override the console bundle location on disk.

## Application Types

| Type          | Use case                                     | Required fields                                   |
| ------------- | -------------------------------------------- | ------------------------------------------------- |
| **framework** | Source code with auto-detected build tooling | `name`, `framework` (`node`, `python`, or `auto`) |
| **container** | Pre-built Docker image                       | `name`, `port`                                    |
| **other**     | Custom app with user-defined scripts         | `name`                                            |

Optional fields available on all types:

- `scripts` — lifecycle hooks: `prebuild`, `build`, `postbuild`, `start`, `test`, `migrate`
- `includes` / `excludes` — filter which files get deployed (framework type only)
- `port` — port your app listens on (required for container, optional for framework)
- `platform` — container platform (defaults to `linux/amd64`, container type only)

## CLI Commands

| Command                             | Description                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------- |
| `appliance login`                   | Authenticate with an Appliance API server                                           |
| `appliance whoami`                  | Show the active profile, server URL, and linked project                             |
| `appliance configure`               | Create or update `appliance.json` interactively                                     |
| `appliance build`                   | Build the application locally                                                       |
| `appliance setup`                   | Connect local codebase to a cloud application (writes `.appliance/link.json`)       |
| `appliance link`                    | Link this folder to an existing project/environment without deploying               |
| `appliance unlink`                  | Remove the local project/environment link                                           |
| `appliance deploy [project] [env]`  | Build (if needed), upload, and deploy; defaults to the linked target                |
| `appliance destroy [project] [env]` | Destroy an environment; defaults to the linked target                               |
| `appliance open [project] [env]`    | Open the latest deployment URL in a browser                                         |
| `appliance status [project]`        | Show application and environment status; defaults to the linked project             |
| `appliance list`                    | List all applications and environments                                              |
| `appliance deployment status <id>`  | Check a specific deployment's status                                                |
| `appliance deployment cancel`       | Cancel an in-flight deployment                                                      |
| `appliance deployment refresh`      | Reconcile Pulumi state with cloud reality                                           |
| `appliance vm up`                   | Boot the isolated microVM local runtime (no docker provider needed for the cluster) |
| `appliance vm stop` / `delete`      | Stop (state preserved) or delete the microVM                                        |
| `appliance vm status`               | Check the microVM runtime, its api-server, and the active profile                   |
| `appliance doctor`                  | Run first-run preflight checks (`--fix` auto-resolves the safe ones)                |

Top-level commands like `setup`, `status`, and `list` are shortcuts for `appliance app setup`, `appliance app status`, and `appliance app list`.

### Local development runtime

`appliance vm up` turns your machine into a self-contained Appliance target: it boots an isolated microVM (Virtualization.framework on macOS) running a Kubernetes cluster with an in-VM image registry, deploys the Appliance api-server _into_ the cluster, and logs you in under the `microvm` profile. From there the normal flow works unchanged against `http://api.appliance.localhost:8081`:

```bash
appliance vm up
APPLIANCE_PROFILE=microvm appliance deploy my-app dev
# → http://my-app-dev.appliance.localhost:8081
```

The same API and SDK drive both targets — deploys against the local runtime build a container image and push it to the in-VM registry, while cloud deploys upload a build for server-side processing.

> The microVM is the sole local runtime; the host-side k3d runtime (`appliance local`) has been removed. macOS / Virtualization.framework is supported today — Linux/Windows wait on the KVM/WSL2 backend.

### The link file

`appliance setup` (and the first successful `appliance deploy`) writes `.appliance/link.json` in your project root, recording the project name, environment name, and which API server they target. Commands run from anywhere inside that tree default to the linked target, so day-to-day usage looks like:

```bash
appliance deploy   # re-deploy linked target
appliance status   # status of linked project
appliance open     # open latest deployment in browser
appliance unlink   # forget the link if you want to start fresh
```

The link file is safe to commit — it contains no secrets, only names. Credentials live in `~/.appliance/profiles.json`.

## Examples

See the [`examples/`](examples/) directory:

- **demo-node-framework** — Node.js Express app deployed as a framework type
- **demo-node-container** — Node.js app deployed as a container
- **demo-python-framework** — Python app deployed as a framework type
- **demo-python-container** — Python app deployed as a container

## Local Kubernetes runtime

For single-machine development, Appliance runs a Kubernetes cluster
inside an isolated microVM it boots itself (`appliance vm up`). The
api-server's `LocalContainerDeploymentService` (the generic
`KubernetesDeploymentService`) maps each appliance to a Kubernetes
Deployment + Service + Ingress via the k8s API — the same engine that
drives a bring-your-own (`appliance-base-kubernetes`) cluster.

Requirements: macOS with Virtualization.framework, plus `docker` /
`kubectl` for building and pushing application images. Quick start:

```bash
appliance vm up
APPLIANCE_PROFILE=microvm appliance deploy my-app dev
appliance destroy my-app dev
```

### Migrating from `appliance local` (k3d)

The host-side k3d local runtime has been removed. Replace it as follows:

- **Local dev:** use `appliance vm up` (the microVM runtime) instead of
  `appliance local up`. Deploy with `--profile microvm`. Application
  images are delivered via the in-VM registry (registry-only — there is
  no `k3d image import` step). `appliance up` remains the near-zero-config
  way to run a single repo's container in the shared sandbox microVM.
- **CI / headless / non-macOS:** point deploys at a real bring-your-own
  `appliance-base-kubernetes` cluster (inline `kubeconfig`, or
  `server` + `token`, plus a `dataDir`). The k3d-in-Docker path is gone
  until the KVM/WSL2 microVM backend lands.

## Development

Install dependencies with `pnpm install` (pnpm workspaces + Nx). The
repo is a TypeScript monorepo plus one Rust crate (`packages/vm`, the
microVM engine).

### Verifying changes — the green bar

`pnpm verify` is **the** green bar. It runs the full verification
sequence and fails on the first error; nothing should reach review
without it passing:

```bash
pnpm verify
```

It runs, in order (see [`scripts/verify.sh`](scripts/verify.sh)):

1. `pnpm run build` — `nx run-many --target=build --all`
2. `pnpm exec nx run-many --target=typecheck --all`
3. `pnpm run lint:check` — ESLint + Prettier `--check`
4. `pnpm exec nx run-many --target=test --all` — Vitest across packages
5. `packages/vm`: `cargo build && cargo test && cargo clippy -- -D warnings`

For a change that touches only a few packages, gate on the affected
ones for a faster loop, e.g.:

```bash
pnpm --filter @appliance.sh/<pkg> run build
pnpm --filter @appliance.sh/<pkg> run test
# Rust only:
cd packages/vm && cargo build && cargo test && cargo clippy
```

Note: `@appliance.sh/bootstrap` and `@appliance.sh/install-aws` carry no
unit tests yet — their `test` scripts are intentional no-ops (they are
exercised by build/integration), so `pnpm verify` stays a meaningful
signal. Add specs there when ready.

## Architecture

For API reference, infrastructure details, and contributor documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## License

The Appliance project is [permissively-licensed under the MIT](/LICENSE).
