# Appliance

A platform for installing and running applications on the cloud. Define your app in a manifest, run one command, and Appliance handles packaging, infrastructure, and routing.

## Getting Started

### 1. Install the CLI

```bash
npm install --global appliance.sh
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
appliance deploy      # Deploy to an environment
```

If your application hasn't been set up yet, `deploy` will automatically walk you through setup. You can also run `appliance setup` directly.

The CLI polls until the deployment completes. Check status anytime with `appliance status <app-name>` or `appliance deployment status <deployment-id>`.

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

| Command                            | Description                                                   |
| ---------------------------------- | ------------------------------------------------------------- |
| `appliance login`                  | Authenticate with an Appliance API server                     |
| `appliance configure`              | Create or update `appliance.json` interactively               |
| `appliance build`                  | Build the application locally                                 |
| `appliance setup`                  | Connect local codebase to a cloud application                 |
| `appliance deploy`                 | Deploy to an environment (runs setup automatically if needed) |
| `appliance destroy`                | Destroy an environment (requires confirmation)                |
| `appliance status <name>`          | Show application and environment status                       |
| `appliance list`                   | List all applications and environments                        |
| `appliance deployment status <id>` | Check a specific deployment's status                          |

Top-level commands like `setup`, `status`, and `list` are shortcuts for `appliance app setup`, `appliance app status`, and `appliance app list`.

## Examples

See the [`examples/`](examples/) directory:

- **demo-node-framework** — Node.js Express app deployed as a framework type
- **demo-node-container** — Node.js app deployed as a container
- **demo-python-framework** — Python app deployed as a framework type

## Architecture

For API reference, infrastructure details, and contributor documentation, see [ARCHITECTURE.md](ARCHITECTURE.md).

## License

The Appliance project is [permissively-licensed under the MIT](/LICENSE).
