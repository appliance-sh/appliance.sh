# Control-plane: one api-server, two base URLs

**Status:** Design (SPIKE E4.0). The decision E4.1–E4.4 implement. No code changes here.

## Goal & invariant

Desktop console and CLI manage all cluster state through **one** appliance
api-server. The local server already runs _inside_ the microVM's k3s; the
cloud server is the _same image_ deployed remotely. A client picks which one
by **base URL** — nothing else differs.

```
  desktop console ─┐                         ┌─ in-VM api-server  (FilesystemObjectStore /persist/appliance-data)
                   ├─ ApplianceClient(baseUrl, creds, RFC 9421) ─┤
  CLI ─────────────┘                         └─ cloud api-server (S3ObjectStore)
```

This is already true for projects / environments / deployments / health. The
remaining divergence is the desktop's **kubectl shell-outs** for workloads and
pod logs, which bypass the server entirely. E4.x closes that gap.

### Verified facts (file:line)

- In-VM server: `packages/helper/src/api-server.ts:24` (`IN_CLUSTER_API_SERVER_HOSTNAME = 'api.appliance.localhost'`), `:126` (Service + Ingress fronted by Traefik → container `:3000`), `:455` `bootstrapInClusterApiServer`. Reachable at `http://api.appliance.localhost:8081` (`api-server.spec.ts:16`, `:88`). VM data dir `/persist/appliance-data` (`packages/cli/src/appliance-vm.ts:223`). The microVM is the sole local runtime; the former host-side k3d bootstrap has been removed.
- **Single ObjectStore per server (confirmed):** `packages/api-server/src/services/storage.service.ts` builds exactly one store — `FilesystemObjectStore(k8s.dataDir)` for k8s bases (`:66`) or one `S3ObjectStore` for cloud (`:72`) — behind a process singleton (`:76-83`). All services go through `getStorageService()`. "Unified state" follows automatically. See [§6](#6-one-objectstore-per-server-confirmed) for the _only_ place a second store sneaks in.
- Auth: clients resolve `apiUrl` via `APPLIANCE_API_URL` → `~/.appliance/profiles.json` profile (`packages/cli/src/utils/credentials.ts:45-52`), then sign with RFC 9421 (`packages/sdk/src/client/appliance-client.ts:35-49`; verify `packages/api-server/src/middleware/auth.ts`). microVM uses `profileForVm(name)` (`packages/cli/src/appliance-vm.ts:53`).
- Desktop frontend **already** drives the server via the SDK: `packages/app/src/hooks/use-appliance-client.ts:26-29` builds an `ApplianceClient` from `selected.apiServerUrl` + `config.apiKey.{id,secret}`. The migration reuses this exact wiring.

## 1. Migrate-to-HTTP vs stay-host-local

The boundary rule: **anything that is a CRUD/read against cluster state moves
behind the api-server** (it is the one component with cluster RBAC + the
ObjectStore, in both local and cloud). **Anything that drives host hardware,
the VM lifecycle, the local toolchain, or signs/inspects traffic stays in the
desktop** — those have no meaning on a remote cloud server and cannot be
expressed as a base-URL-selected HTTP call.

| `lib.rs` command                                                                                   | Disposition        | Why                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list_local_workloads` (`:4100`, `kubectl get deploy,pod,svc -o json` `:4110`)                     | **MIGRATE → HTTP** | Pure cluster read. Server already has CoreV1/AppsV1 + RBAC.                                                                                                  |
| `tail_local_pod_logs` (`:4241`, `kubectl logs` `:4255`)                                            | **MIGRATE → HTTP** | Cluster read; RBAC `pods/log` already granted (`api-server.ts:166`).                                                                                         |
| cluster _readiness_ (the "is k3s/api-server serving" signal inside `local_cluster_status` `:1685`) | **MIGRATE → HTTP** | A reachability probe of the server (`GET /healthz`) is the real readiness test.                                                                              |
| `microvm_*` — install/up/stop/delete/status (`:3187`–`:3709`)                                      | **STAY**           | VM lifecycle on the host hypervisor. Distinct from cluster-ready (`microvm_status` reports VM phases).                                                       |
| `terminal_*` / PTY (`:4267`+)                                                                      | **STAY**           | Interactive `kubectl exec` / `kubectl debug node` + chroot into the VM host — a bidirectional PTY, not a request/response; host-only `debug node` semantics. |
| egress / MITM — `microvm_egress_*` (`:3772`+)                                                      | **STAY**           | Host-side proxy + CA injection on the VM's network edge.                                                                                                     |
| code-signing, AWS profile reading, `docker build`, image push                                      | **STAY**           | Local toolchain / host credentials; no cluster-state meaning.                                                                                                |
| `promote_state` / `demote_state` (`:1181` / `:1206`), `update_baseline`                            | **STAY**           | Operate on Pulumi **installer** state (a _separate_ backend, see §6), need docker + host AWS creds. Not app state.                                           |

Net: exactly two reads (`list_local_workloads`, `tail_local_pod_logs`) plus the
readiness sub-signal migrate; the `kube_target_args` kubeconfig plumbing
(`:4071`) they depend on can then be deleted. Everything else is correctly
host-local.

## 2. New api-server endpoints (E4.1)

The server already talks to the cluster via `@kubernetes/client-node`
(`CoreV1Api` + `AppsV1Api`, `loadFromCluster()` in-cluster) inside
`packages/infra/src/lib/local/LocalContainerDeploymentService.ts:141-158,642`,
and already lists pods for health (`listNamespacedPod` `:390`). RBAC for
`pods`, `services`, `deployments`, `replicasets`, `ingresses`, **and
`pods/log`** is already bound (`packages/helper/src/api-server.ts:156-167`).
So E4.1 is additive: new read methods on the infra client + thin routes. No new
RBAC, no new k8s wiring.

All routes mount under the existing `signatureAuth` (`main.ts:49-54`) and are
gated to Kubernetes bases — on AWS/Lambda bases they return `409` with an
explanatory body, mirroring `environment-health.service.ts:35-40` (`isKubernetesBase`).

**`GET /api/v1/workloads?namespace=<ns>`** — defaults to the server's
configured namespace (`appliance`, `lib.rs:1308`). Returns the shape the desktop
already renders (`LocalWorkloads`, `lib.rs:4023-4061`):

```jsonc
{ "deployments": [{ "name","image","desired","ready","available","createdAt" }],
  "pods":        [{ "name","phase","ready","restartCount","containerImage","createdAt" }],
  "services":    [{ "name","type","clusterIP","nodePort","targetPort" }] }
```

(Optional environment-scoped variant `GET /api/v1/environments/:id/workloads`
filters by `app.kubernetes.io/name=<stackName>` — the selector the infra layer
already uses, `LocalContainerDeploymentService.ts:391`.)

**`GET /api/v1/pods/:name/logs`** — query: `container`, `tailLines` (default
200), `namespace`, `follow` (bool), `sinceSeconds`.

- **Snapshot** (`follow` unset): `Content-Type: text/plain`, the tail as one
  body. Drop-in for `tail_local_pod_logs`.
- **Streaming** (`follow=1`): **chunked `text/plain`** via the client-node `Log`
  helper with `{ follow: true, tailLines }`, piping the k8s watch stream
  straight to the HTTP response. (SSE is unnecessary — raw chunked log lines are
  simpler for both the Rust side and the browser; pick SSE only if the console
  later wants typed events.)

**How streaming authenticates with signed requests.** The signature covers a
GET with **no body**, so only the derived components (`@method`, `@authority`,
`@path`, `created`, `expires`) are signed — the SDK already takes this branch
for body-less requests (`appliance-client.ts:42-49`) and the verifier skips the
content-digest when there is no body (`auth.ts:24`). Auth is checked **once, at
connection open**; the `expires` window gates _establishing_ the stream, not its
duration, so a long-lived `follow` stream stays open past the signature window.
The client closes by aborting the request.

**Readiness:** add an unauthenticated **`GET /healthz`** (liveness only, no
state) so the desktop's cluster-ready probe is a base-URL HTTP check rather than
`kubectl`. (The signed `GET /api/v1/cluster-info` already exists for richer
status, `main.ts:54`.)

## 3. SDK client methods (E4.2)

Add to `ApplianceClient` (`packages/sdk/src/client/appliance-client.ts`). The
existing `request<T>` helper covers the JSON snapshot calls; **log streaming
needs a new method** because `request` buffers via `response.json()` and cannot
yield incrementally.

```ts
// JSON, via the existing request<T> path
listWorkloads(opts?: { namespace?: string }): Promise<Result<Workloads>>;
listEnvironmentWorkloads(environmentId: string): Promise<Result<Workloads>>;

// Snapshot tail — text body, not JSON
getPodLogs(pod: string, opts?: {
  container?: string; tailLines?: number; namespace?: string; sinceSeconds?: number;
}): Promise<Result<string>>;

// Streaming — signs a body-less GET, returns lines until aborted
streamPodLogs(
  pod: string,
  opts: { container?: string; tailLines?: number; namespace?: string; signal: AbortSignal },
  onLine: (line: string) => void,
): Promise<Result<void>>;

healthz(): Promise<Result<{ ok: true }>>; // unsigned liveness probe
```

`Workloads` is a new exported SDK model matching the §2 shape (and the existing
`LocalWorkloads` Rust struct, so the desktop UI types are unchanged).

## 4. Desktop migration (E4.3)

The desktop **already** has the base URL + credentials for the active cluster:
`use-appliance-client.ts` reads `selected.apiServerUrl` and `config.apiKey`
(synced from `cluster:<id>` / profiles.json) and builds the signed client. The
local-runtime workloads page and the log viewer call the Tauri commands today
via `host.ts:207` (`list_local_workloads`) and `:210` (`tail_local_pod_logs`).

Migration:

1. Replace those two `host.local.*` calls with `client.listWorkloads()` and
   `client.getPodLogs()` / `client.streamPodLogs()` from `useApplianceClient()`
   — the same hook already powering projects/deployments. No new auth or URL
   plumbing; the in-VM server is reached at `apiServerUrl`
   (`http://api.appliance.localhost:8081`) exactly as the rest of the console is.
2. The live-tail panel switches from periodic `tailPodLogs` polling to one
   `streamPodLogs(..., { signal })` call, aborted on unmount / pod switch.
3. Cluster-ready badge: probe `client.healthz()` (or reuse `cluster-info`)
   instead of the kubectl reachability path; keep `microvm_status` for the
   VM-running-vs-cluster-ready distinction.
4. Delete `list_local_workloads`, `tail_local_pod_logs`, and `kube_target_args`
   from `lib.rs`, plus their `invoke_handler` registrations (`:5109-5110`).
   `kubectl` stays a declared dependency only for the surviving PTY/terminal and
   `kubectl apply` deploy paths.

The CLI gets the same reads for free (`appliance vm` could grow
`workloads` / `logs` subcommands calling the new SDK methods) but that is not
required for E4.3.

## 5. Credential unification (E4.4) — needs Sasha (security) review

A full plan already exists in [`docs/credentials.md`](./credentials.md) §"Single
source of truth"; E4.4 _executes_ it rather than re-deciding it.

**Canonical store: `~/.appliance/profiles.json` (mode `0600`).** It is the only
store both surfaces already read and write, is cross-platform, and carries the
richest metadata. The macOS Keychain (`sh.appliance.desktop` / `cluster:<id>`,
`lib.rs:25`) becomes a **derived cache** of the active profile's secret, written
_from_ profiles.json and never read back as a source.

**The bridge (so desktop-authed ↔ CLI-usable both ways):** generalize the
one-way `synced_key_id` reconciliation that already works for microVM clusters
to _all_ desktop clusters. profiles.json → Keychain on a `keyId` mismatch,
judged by file comparison (no Keychain prompt). The stage-1 non-destructive
**seed** that copies Keychain-only secrets into profiles.json is already
implemented (`lib.rs:341` `decide_seed`, `:404` `seed_profiles_from_keychain`),
so no credential is stranded when the read direction flips. Add a cross-process
`flock` on profiles.json before the legacy mirrors are collapsed, so a CLI
`keys rotate` and a desktop sync can't interleave a read-modify-write
(`credentials.md` open question).

**Security fork — decide before flipping (OWNER: Sasha):**

- **Keychain (today, desktop-primary):** secret sits in an OS-hardened,
  access-gated store. Strongest at-rest posture, but macOS-only and not what the
  CLI can read — the source of the split.
- **profiles.json `0600` (target canonical):** cross-platform and the only
  shared store, but **cleartext on disk**. Consolidating _more_ secrets there
  raises the value of an attacker reading the file.
- **Open question for Sasha: should secrets ever leave the Keychain?** The
  consolidation deliberately copies the secret into cleartext profiles.json.
  Alternatives to weigh: (a) accept `0600` cleartext (status quo for CLI today);
  (b) encrypt profiles.json at rest with an OS-bound key (Keychain-wrapped DEK /
  libsecret / DPAPI) so the canonical file is ciphertext and the Keychain guards
  only the wrapping key; (c) keep the secret in the Keychain and have the CLI
  read _through_ the Keychain on macOS. **Recommendation:** ship (a) to unify now
  (it is no weaker than the CLI's existing posture), and gate the move to (b) on
  Sasha's review — `credentials.md` already flags at-rest encryption as the
  security-review gate for the final step.

## 6. One ObjectStore per server (confirmed)

`getStorageService()` is a process singleton over a single store (§1 facts).
There is exactly one app-state ObjectStore per api-server, so once the desktop
reads workloads/logs through the server, local and cloud share the same
single-source state automatically.

**The only "second store" to keep out:** the desktop's own kubectl read path
_is_ a divergent, ObjectStore-bypassing view of cluster state today — that is
the gap §1–§4 close. Do **not** reintroduce direct cluster reads in the desktop
after migration. Separately, the Pulumi **installer** state backend
(`stateBackendUrl`; `promote_state`/`demote_state`, `lib.rs:1181`/`:1206`) is a
_distinct_ store by design — it holds infra/installer state, not appliance app
data, and correctly stays host-local; it is not a second app-state store and
must not be folded into the api-server ObjectStore.
