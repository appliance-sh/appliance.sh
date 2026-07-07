# The local server: one binary, cloud orchestrator and local daemon

**Status:** Implemented (`appliance server start|stop|status|logs`,
`--runtime vm|docker`).

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
- **Runtime (`vm`, the default):** the `appliance-base-kubernetes`
  base pointed at the **microVM's k3s** through its forwarded
  kubeconfig. The host daemon drives the VM's cluster directly — no
  in-cluster api-server, no api-server image delivery. Images build
  via the VM's **in-guest BuildKit** (`buildctl` against the
  forwarded `tcp://127.0.0.1:5054`), so **no Docker is needed
  anywhere**.
- **Runtime (`docker`):** the original `appliance-base-docker` base —
  deploys are containers on the local Docker daemon
  (`DockerDeploymentService` in `packages/infra`), no cluster, no
  registry, no manifests.
- **Auth:** the standard bootstrap-token → API-key mint, saved to the
  `local` credential profile. Every request is RFC 9421-signed exactly
  as against a cloud installation.

The daemon itself is ready in about a second (the vm runtime adds the
microVM boot on a cold start — seconds when warm, minutes the first
ever time). The same code deployed with an AWS or Kubernetes base
config is the cloud control plane — the binary is the contract; only
`APPLIANCE_BASE_CONFIG` changes.

## Command surface

```
appliance server start [--port 8082] [--data-dir <path>] [--foreground] [--runtime vm|docker]
appliance server stop [--vm]  # daemon only; --vm also parks the microVM
appliance server status
appliance server logs [--tail n] [-f]
```

`start` is idempotent: a reachable server with matching configuration
short-circuits to a credentials check. A runtime switch — or a
recreated VM whose kubeconfig no longer matches the one baked into the
daemon's env (tracked as `kubeconfigSha`) — restarts the daemon
cleanly. State lives in `~/.appliance/server/server.json` (port,
dataDir, pid, bootstrap token, runtime, mode 0600); the daemon's log
is `~/.appliance/server/server.log`.

## Deploy path (vm runtime, the default)

`appliance deploy --profile local`:

1. The CLI probes `/cluster-info`, sees `appliance-base-kubernetes`
   with a `buildkit.addr`.
2. Builds the manifest's Dockerfile **inside the VM's buildkitd** via
   the managed `buildctl` binary: the build context streams over the
   forwarded gRPC port (content-addressed — rebuilds send only changed
   files), and the image is pushed guest-side to the in-VM registry
   under `localhost:5052/<name>` — the same ref the kubelet pulls
   through the containerd mirror. The digest-qualified ref registers
   as a remote-image build (deploy-by-digest → unchanged builds are
   idempotent no-ops). BuildKit's layer cache persists in the VM, so
   the save→rollout loop is seconds. Falls back to
   `docker build` + `crane push` when buildkitd isn't reachable.
3. The server's executor dispatches to `KubernetesDeploymentService`
   exactly as the microvm profile does: Deployment + Service + Ingress
   per stack, `http://<project>-<env>.appliance.localhost:8081`,
   `replicas` honored.

## Deploy path (docker runtime)

`appliance deploy --profile local` with `--runtime docker`:

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
4. Every container joins the shared `appliance` docker network with
   its stack name as a DNS alias, so stacks reach each other at
   `http://<project>-<env>:<port>` — the same address the Kubernetes
   backend serves via its Service name. (`localhost:<hostport>` URLs
   are host-facing; inside a container, localhost is the container.)
   `host.docker.internal` is also mapped (`host-gateway`) for
   reaching services that run on the host itself. Stack files can
   declare this wiring declaratively — see "Wiring members together"
   in the README.

Health, workloads, and container logs flow through the same
`/api/v1/environments/:id/health|workloads` + `/api/v1/pods/:name/logs`
endpoints the console uses — a container maps onto one
Deployment/Pod/Service row, so the k8s-shaped UI carries over.

## The dev loop: `appliance dev`

The polished front door over the vm runtime. In an app or stack
directory:

```
appliance dev [environment] [-f stack.json] [--runtime vm|docker] [--no-logs] [--no-watch]
```

1. Ensures the local server (and its microVM) is up — one command from
   a cold machine to a running control plane, no Docker.
2. Deploys the stack (or the current app as a one-member stack) with
   the exact `appliance stack deploy` engine, `{{service:…}}` wiring
   included, and prints the URL summary.
3. Streams every member's pod logs merged into one feed,
   color-prefixed per member (`web      | listening on :3000`).
   Rollouts are picked up automatically via the workloads API.
4. Watches each member's sources (`fs.watch` recursive; node_modules /
   .git / build output / editor noise ignored) and rebuilds +
   redeploys the changed member — debounced, serialized, BuildKit
   cache-warm. Saving an unchanged file ends as a `No changes` no-op.
5. Ctrl+C ends the session and **leaves the apps running**, printing
   their URLs and the teardown command (`appliance stack destroy`).

`--profile microvm` (or a cloud profile) skips the server management
and runs the same loop against that control plane — logs and deploys
ride the same API everywhere.

## Choosing a local runtime

|               | `server` (vm runtime, default)            | `server --runtime docker`  | `appliance init` (in-VM api-server)       |
| ------------- | ----------------------------------------- | -------------------------- | ----------------------------------------- |
| Bring-up      | ~1 s warm; VM boot when cold              | ~1 s                       | minutes on first boot                     |
| Needs         | virtualization only — **no Docker**       | Docker daemon              | virtualization + Docker for builds        |
| Builds        | in-guest BuildKit (`buildctl`)            | `docker build`             | host `docker build` + crane push          |
| Isolation     | dedicated VM                              | host Docker daemon         | dedicated VM, egress confinement          |
| Replicas      | honored                                   | ignored (single container) | honored (`replicas` in the manifest)      |
| URL shape     | `http://<stack>.appliance.localhost:8081` | `http://localhost:<port>`  | `http://<stack>.appliance.localhost:8081` |
| Parity target | local dev, cloud-shaped                   | quick demo w/ Docker       | closest to the Kubernetes cloud path      |

All are ordinary profiles (`local` / `microvm`), so `--profile`
switches between them and everything above them — deploy, stack,
env, destroy, console — is identical. The vm runtime and `appliance
init` share the same VM (`appliance`), registry, and cluster — they
differ only in where the api-server runs.

## Limitations (by design, for now)

- **Container manifests only** — same restriction as Kubernetes bases;
  framework (zip) appliances still need the cloud path or a Dockerfile.
- **Docker runtime: `replicas` is ignored** (single container per
  stack; the message says so when a manifest asks for more) — the vm
  runtime honors it.
- **Egress confinement** applies to the vm runtime's workloads only in
  the policy-cooperative sense at first start (`egress sync` runs
  best-effort before the namespace exists); `appliance vm` remains the
  authority on egress.
- The daemon binds `127.0.0.1` and is single-operator; team
  installations belong on a cloud base.
