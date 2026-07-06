# The local server: one binary, cloud orchestrator and local daemon

**Status:** Implemented (`appliance server start|stop|status|logs`).

## Premise

The api-server was only ever _packaged_ heavy, never _built_ heavy: it
is an Express app whose state is JSON blobs over a pluggable
`ObjectStore` (with a filesystem implementation) and whose only
Kubernetes dependency is one deploy-backend class. Yet the local story
hosted it inside k3s in the microVM, which made "deploy locally" pay
for a VM boot, a k3s bring-up, an in-VM registry wait, and a
`docker save` + `crane push` delivery of the api-server image — a
long, fragile chain for what a laptop needs.

`appliance server` runs the **same api-server, embedded in the CLI
binary**, as a plain host process:

- **State:** `FilesystemObjectStore` at `~/.appliance/server/data`.
- **Runtime:** the `appliance-base-docker` base — deploys are
  containers on the local Docker daemon
  (`DockerDeploymentService` in `packages/infra`), no cluster, no
  registry, no manifests.
- **Auth:** the standard bootstrap-token → API-key mint, saved to the
  `local` credential profile. Every request is RFC 9421-signed exactly
  as against a cloud installation.

Ready in about a second. The same code deployed with an AWS or
Kubernetes base config is the cloud control plane — the binary is the
contract; only `APPLIANCE_BASE_CONFIG` changes.

## Command surface

```
appliance server start [--port 8082] [--data-dir <path>] [--foreground]
appliance server stop        # daemon only; deployed containers keep running
appliance server status
appliance server logs [--tail n] [-f]
```

`start` is idempotent: a reachable server short-circuits to a
credentials check. State lives in `~/.appliance/server/server.json`
(port, dataDir, pid, bootstrap token, mode 0600); the daemon's log is
`~/.appliance/server/server.log`.

## Deploy path (docker base)

`appliance deploy --profile local`:

1. The CLI probes `/cluster-info`, sees `appliance-base-docker`.
2. Builds the manifest's container image **into the local daemon**
   (`buildLocalApplianceImage`, `utils/local-image.ts`) — pinned to
   the host arch like the microVM path — and registers the immutable
   image ID (`sha256:…`) as a remote-image build. **No push**: the
   server runs containers on the same daemon the build landed in.
   Deploy-by-ID makes redeploys roll exactly when content changed
   (same source → same ID → idempotent no-op).
3. The server's executor dispatches to `DockerDeploymentService`:
   one container per stack, named `appliance-<project>-<env>`,
   published on a deterministic host port (8300–8699, hashed from the
   stack name, stable across redeploys) → `http://localhost:<port>`.
   Deploy-time env and port ride on `sh.appliance.*` labels so a bare
   redeploy preserves them, mirroring the k8s backend's contract.

Health, workloads, and container logs flow through the same
`/api/v1/environments/:id/health|workloads` + `/api/v1/pods/:name/logs`
endpoints the console uses — a container maps onto one
Deployment/Pod/Service row, so the k8s-shaped UI carries over.

## Choosing a local runtime

|               | `appliance server` (docker base) | `appliance init` (microVM + k3s)          |
| ------------- | -------------------------------- | ----------------------------------------- |
| Bring-up      | ~1 s                             | minutes on first boot                     |
| Needs         | Docker daemon                    | virtualization + Docker for builds        |
| Isolation     | host Docker daemon               | dedicated VM, egress confinement          |
| Replicas      | ignored (single container)       | honored (`replicas` in the manifest)      |
| URL shape     | `http://localhost:<port>`        | `http://<stack>.appliance.localhost:8081` |
| Parity target | quick local dev/demo             | closest to the Kubernetes cloud path      |

Both are ordinary profiles (`local` / `microvm`), so `--profile`
switches between them and everything above them — deploy, stack,
env, destroy, console — is identical.

## Limitations (by design, for now)

- **Container manifests only** — same restriction as Kubernetes bases;
  framework (zip) appliances still need the cloud path or a Dockerfile.
- **`replicas` is ignored** (single container per stack; the message
  says so when a manifest asks for more) — scale-out is what the
  Kubernetes/cloud bases are for.
- **No egress confinement** — the desktop's outbound-traffic policy is
  a microVM feature.
- The daemon binds `127.0.0.1` and is single-operator; team
  installations belong on a cloud base.
