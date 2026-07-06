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

No server yet? Two local-first paths, no login or setup needed:

- **`appliance server start`** — the fastest: runs the control plane as a lightweight daemon on your machine (ready in ~1 s, needs only Docker) and saves the `local` profile. Deploys become containers on your Docker daemon.
- **`appliance init`** — the isolated path: boots the microVM runtime (its own VM + Kubernetes), saves the `microvm` profile, and hands you straight into the first deploy.

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
- `replicas` — pod count on Kubernetes bases (the microVM local runtime and BYO clusters); ignored on Lambda and local-docker bases. When omitted, redeploys keep the environment's current scale.

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
| `appliance stack init`              | Scan subdirectories for manifests and write an `appliance.stack.json` collection    |
| `appliance stack deploy [env]`      | Deploy every app in the stack, in file order, with a combined URL summary           |
| `appliance stack status [env]`      | Show every stack app's environment status and URL                                   |
| `appliance stack destroy [env]`     | Destroy every stack app's environment (one confirmation for the whole set)          |
| `appliance open [project] [env]`    | Open the latest deployment URL in a browser                                         |
| `appliance status [project]`        | Show application and environment status; defaults to the linked project             |
| `appliance list`                    | List all applications and environments                                              |
| `appliance deployment status <id>`  | Check a specific deployment's status                                                |
| `appliance deployment cancel`       | Cancel an in-flight deployment                                                      |
| `appliance deployment refresh`      | Reconcile Pulumi state with cloud reality                                           |
| `appliance server start`            | Run the control plane as a lightweight local daemon (no VM/k3s; profile `local`)    |
| `appliance server stop` / `status`  | Stop the local daemon (containers keep running) / show its state and URL            |
| `appliance server logs`             | Print (or `-f` follow) the local daemon's log                                       |
| `appliance vm up`                   | Boot the isolated microVM local runtime (no docker provider needed for the cluster) |
| `appliance vm stop` / `delete`      | Stop (state preserved) or delete the microVM                                        |
| `appliance vm status`               | Check the microVM runtime, its api-server, and the active profile                   |
| `appliance doctor`                  | Run first-run preflight checks (`--fix` auto-resolves the safe ones)                |

Top-level commands like `setup`, `status`, and `list` are shortcuts for `appliance app setup`, `appliance app status`, and `appliance app list`.

### Local development runtimes

Two ways to run Appliance on your machine, both ordinary credential profiles (switch with `--profile` / `APPLIANCE_PROFILE`):

**The local server (fastest).** `appliance server start` embeds the same api-server that powers cloud installations directly in the CLI binary and runs it as a host daemon — no VM, no Kubernetes, no registry. It's ready in about a second, stores state under `~/.appliance/server/data`, and deploys become containers on your local Docker daemon with stable `http://localhost:<port>` URLs. Deploys build straight into the daemon (no push step at all), making it the tightest build→deploy loop available:

```bash
appliance server start
appliance deploy my-app dev --profile local
# → http://localhost:8342
```

See [`docs/local-server.md`](docs/local-server.md) for the full contract and how it compares with the microVM.

**The microVM runtime (isolated).** `appliance vm up` (or `appliance init`) boots an isolated microVM (Virtualization.framework on macOS) running a Kubernetes cluster with an in-VM image registry, deploys the Appliance api-server _into_ the cluster, and logs you in under the `microvm` profile. Deploys honor `replicas`, get hostname-routed URLs like the cloud, and are confined by the desktop's egress policy:

```bash
appliance vm up
APPLIANCE_PROFILE=microvm appliance deploy my-app dev
# → http://my-app-dev.appliance.localhost:8081
```

The same API and SDK drive every target — local-server deploys build into the host daemon, microVM deploys push to the in-VM registry, and cloud deploys upload a build for server-side processing.

> The host-side k3d runtime (`appliance local`) has been removed. The microVM supports macOS (Virtualization.framework) and Windows (WSL2) today — Linux waits on the KVM backend; the local server runs anywhere Node + Docker do.

### The link file

`appliance setup` (and the first successful `appliance deploy`) writes `.appliance/link.json` in your project root, recording the project name, environment name, and which API server they target. Commands run from anywhere inside that tree default to the linked target, so day-to-day usage looks like:

```bash
appliance deploy   # re-deploy linked target
appliance status   # status of linked project
appliance open     # open latest deployment in browser
appliance unlink   # forget the link if you want to start fresh
```

The link file is safe to commit — it contains no secrets, only names. Credentials live in `~/.appliance/profiles.json`.

### Stacks — collections of appliances

For local testing, demos, and prototyping you rarely want one app — you want the whole set. An `appliance.stack.json` names a collection of appliance directories so they deploy, report, and tear down as a unit:

```json
{
  "manifest": "v1",
  "type": "stack",
  "name": "demos",
  "environment": "dev",
  "apps": [{ "dir": "web" }, { "dir": "api", "project": "api-server" }]
}
```

```bash
appliance stack init          # scaffold the file by scanning subdirectories
appliance stack deploy        # deploy every member, print a combined URL table
appliance stack status        # every member's status + URL at a glance
appliance stack destroy       # tear the whole set down (asks once)
```

Each member still becomes an ordinary project + environment on the server, so the same stack file drives the local microVM **and** a cloud installation — `appliance stack deploy --profile <cloud-profile>` spins up an identical set in the cloud, and `appliance stack deploy demo2` clones the collection into a fresh environment. Environment precedence per app: CLI argument > per-app `environment` > stack `environment` > `dev`.

### Coding agents in the sandbox

Appliance can also run coding agents (Claude Code, GitHub Copilot, OpenAI Codex) inside an isolated sandbox microVM with your working tree mounted — credentials stay host-side and are injected per-request by the egress broker, never written into the VM:

```bash
appliance agent login                                  # one-time, per provider (--type copilot|codex)
appliance agent start                                  # boots the sandbox VM, launches the agent on cwd
appliance agent start --autonomous --task "…" --wait   # headless run to completion
appliance agent list / attach <id> / stop <id>         # session lifecycle
```

Note: `appliance agent` uses the shared sandbox VM (`appliance-sbx`), which boots in seconds — it is separate from the k3s deploy runtime that `appliance init` / `appliance vm up` boot. See [`docs/agent-sandbox.md`](docs/agent-sandbox.md) for the threat model and its limits.

## Examples

See the [`examples/`](examples/) directory:

- **demo-node-framework** — Node.js Express app deployed as a framework type
- **demo-node-container** — Node.js app deployed as a container
- **demo-python-framework** — Python app deployed as a framework type
- **demo-python-container** — Python app deployed as a container

The directory also carries an [`appliance.stack.json`](examples/appliance.stack.json), so all four come up with one command:

```bash
cd examples && appliance stack deploy
```

## Local Kubernetes runtime

For single-machine development, Appliance runs a Kubernetes cluster
inside an isolated microVM it boots itself (`appliance vm up`). The
api-server's `LocalContainerDeploymentService` (the generic
`KubernetesDeploymentService`) maps each appliance to a Kubernetes
Deployment + Service + Ingress via the k8s API — the same engine that
drives a bring-your-own (`appliance-base-kubernetes`) cluster.

Requirements: macOS with Virtualization.framework or Windows with
WSL2, plus `docker` / `kubectl` for building and pushing application
images. Quick start:

```bash
appliance vm up
APPLIANCE_PROFILE=microvm appliance deploy my-app dev
appliance destroy my-app dev
```

If you don't need VM isolation or k8s parity, `appliance server start`
is the lighter alternative: the same api-server as a host daemon,
deploying containers straight to your Docker daemon
(`appliance-base-docker`, `DockerDeploymentService`). See
[`docs/local-server.md`](docs/local-server.md).

### Migrating from `appliance local` (k3d)

The host-side k3d local runtime has been removed. Replace it as follows:

- **Local dev:** use `appliance vm up` (the microVM runtime) instead of
  `appliance local up`. Deploy with `--profile microvm`. Application
  images are delivered via the in-VM registry (registry-only — there is
  no `k3d image import` step). `appliance up` remains the near-zero-config
  way to run a single repo's container in the shared sandbox microVM.
- **CI / headless / Linux:** point deploys at a real bring-your-own
  `appliance-base-kubernetes` cluster (inline `kubeconfig`, or
  `server` + `token`, plus a `dataDir`). The k3d-in-Docker path is gone;
  the microVM runs on macOS (Virtualization.framework) and Windows
  (WSL2) today, with Linux waiting on the KVM backend.

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
