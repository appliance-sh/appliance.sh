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

| Command                             | Description                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `appliance login`                   | Authenticate with an Appliance API server                                     |
| `appliance whoami`                  | Show the active profile, server URL, and linked project                       |
| `appliance configure`               | Create or update `appliance.json` interactively                               |
| `appliance build`                   | Build the application locally                                                 |
| `appliance setup`                   | Connect local codebase to a cloud application (writes `.appliance/link.json`) |
| `appliance link`                    | Link this folder to an existing project/environment without deploying         |
| `appliance unlink`                  | Remove the local project/environment link                                     |
| `appliance deploy [project] [env]`  | Build (if needed), upload, and deploy; defaults to the linked target          |
| `appliance destroy [project] [env]` | Destroy an environment; defaults to the linked target                         |
| `appliance open [project] [env]`    | Open the latest deployment URL in a browser                                   |
| `appliance status [project]`        | Show application and environment status; defaults to the linked project       |
| `appliance list`                    | List all applications and environments                                        |
| `appliance deployment status <id>`  | Check a specific deployment's status                                          |
| `appliance deployment cancel`       | Cancel an in-flight deployment                                                |
| `appliance deployment refresh`      | Reconcile Pulumi state with cloud reality                                     |

Top-level commands like `setup`, `status`, and `list` are shortcuts for `appliance app setup`, `appliance app status`, and `appliance app list`.

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
- **demo-local-runtime.sh** — end-to-end deploy/destroy of both
  container demos against the local Kubernetes runtime (k3d)

## Local Kubernetes runtime

For offline / single-machine development, Appliance supports a
`appliance-base-local` base that targets a k3d cluster on the
developer's machine instead of AWS. The desktop app manages the
cluster lifecycle (start, stop, delete) and the api-server's
`LocalContainerDeploymentService` maps each appliance to a
Kubernetes Deployment + Service via `kubectl apply` / `kubectl delete`.

Requirements: `docker`, `k3d`, `kubectl`.

Quick start:

```bash
# from the repo root
./examples/demo-local-runtime.sh
```

The script boots a k3d cluster, builds + imports the
`demo-node-container` and `demo-python-container` images, launches
the api-server with an `appliance-base-local` config, deploys both
demos, and then destroys them. State persists under
`~/.appliance/local-runtime`.

## Architecture

For API reference, infrastructure details, and contributor documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## License

The Appliance project is [permissively-licensed under the MIT](/LICENSE).
