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

## 5. Credential unification (E4.4) — Keychain-first (IMPLEMENTED)

**OWNER DECISION (overrides the spike).** This section originally recommended
making `~/.appliance/profiles.json` the canonical secret store and demoting the
Keychain to a derived cache. The owner reversed that: the canonical secret store
is the **OS keystore (macOS Keychain) on macOS**, with **`~/.appliance/profiles.json`
(mode `0600`) as the fallback on non-macOS** (Linux / cloud / CI). The goal is a
cluster authed in the desktop being usable by the CLI and vice-versa, with the
secret living in the Keychain where one exists and **never duplicated to
cleartext on macOS**. The notes below record what shipped (option (c) from the
old "security fork", not (a)).

### The model — who reads what, from where

| Platform      | Canonical secret store                                | profiles.json holds                                                                   | CLI reads the secret from           |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------- |
| **macOS**     | OS Keychain (`sh.appliance.desktop` / `cluster:<id>`) | metadata only (apiUrl, keyId, name, …); **empty secret** for desktop-managed clusters | the Keychain (file is the fallback) |
| **non-macOS** | `~/.appliance/profiles.json` (`0600`)                 | full credential (apiUrl, keyId, **secret**)                                           | profiles.json                       |

Both surfaces still share **one** `profiles.json` for metadata + cluster
discovery, so desktop and CLI see the same set of clusters everywhere.

### Implementation

**CLI — read (`packages/cli/src/utils/keychain.ts`, wired in
`utils/credentials.ts` `loadCredentials`).** A new `resolveProfileSecret(name,
profile)` resolves the secret **Keychain-first on macOS** for desktop-managed
profiles (`managed === "desktop"`), falling back to the file copy elsewhere /
on a miss. The Keychain account mirrors the desktop's naming exactly — service
`sh.appliance.desktop`, account `cluster:<id>`, where the profiles.json map key
**is** the desktop cluster id. The read shells out to
`/usr/bin/security find-generic-password -w` and parses the stored JSON
`{"id","secret"}` (a serialized `ApiKey`). The pure `chooseCredential()` helper
is unit-tested (`keychain.spec.ts`): Keychain wins normally, but a non-empty
file secret whose `keyId` differs from the Keychain's is treated as **fresher**
(a CLI rotate that couldn't reach the Keychain) and preferred — `keyId` is the
version marker, so a degraded write self-heals instead of serving a stale key.
All existing SDK-client consumers (`deploy`, `logs`, `open`, `whoami`, `keys`,
…) go through `loadCredentials`, so they pick this up for free.

**Desktop — write (`packages/desktop/src-tauri/src/lib.rs`).**
`mirror_to_shared_profiles` now writes an **empty secret** into profiles.json
for desktop-managed clusters on macOS (`shared_secret_for_platform`, pure +
unit-tested), keeping the (non-secret) `keyId`/metadata and leaving the secret
solely in the Keychain. `seed_profiles_from_keychain` (which used to copy
Keychain secrets _into_ profiles.json) is a **no-op on macOS** — that copy is
exactly the cleartext duplication we now avoid; it stays active on non-macOS,
where the file is canonical. `ingest_shared_into_legacy` skips the Keychain
write when a shared entry's secret is empty, so a metadata-only macOS entry can
never clobber the real Keychain copy.

**Bridge — both directions.**

- _Desktop-authed → CLI:_ desktop writes secret → Keychain + metadata →
  profiles.json; CLI reads metadata from the file and the secret from the
  Keychain. No cleartext on disk.
- _CLI-authed → desktop:_ unchanged. `appliance login` / `init` / `vm up`
  create **CLI-managed** profiles (secret in profiles.json), and the desktop
  adopts them via the existing `sync_microvm_cluster` / `synced_key_id`
  reconcile (profiles.json → Keychain on a `keyId` mismatch, judged by file
  comparison so it never prompts). `appliance keys rotate` of a desktop-managed
  cluster now pushes the new key **to the Keychain** (`writeKeychainApiKey`,
  `-U` upsert) and keeps profiles.json secret empty; if that write fails it
  falls back to writing the secret to the file, and the differing `keyId` makes
  the CLI prefer that fresher copy.

**Concurrency — `flock` on profiles.json.** `profile-store.ts` now wraps every
read-modify-write (`upsertProfile` / `removeProfile` / `setActiveProfile`) in a
best-effort advisory lockfile (`profiles.json.lock`, O_EXCL with stale-steal
after 10 s and a 2 s give-up so it never wedges the CLI). This closes the
CLI-vs-CLI interleave from the `credentials.md` open question (e.g. `keys
rotate` racing `vm up`). **Residual:** the desktop (Rust) still uses an
in-process mutex + atomic temp-rename and does **not** yet take this lockfile,
so a desktop↔CLI interleave remains last-writer-wins (both write atomically, so
no half-written read). Having the desktop adopt the same lockfile is the
remaining piece.

### At-rest security posture (for Sasha)

- **macOS:** the secret lives **only** in the OS-hardened, access-gated
  Keychain. profiles.json carries metadata with an empty secret — no cleartext
  secret on disk. Strongest posture; this is option (c) from the old fork.
- **non-macOS:** secret in `profiles.json` at `0600` (cleartext), unchanged from
  the CLI's prior posture — the CLI can't read libsecret/DPAPI, so the file
  stays canonical there.

**Flagged for review:**

1. **Cross-binary Keychain access prompt.** The CLI reads the desktop-created
   item via `/usr/bin/security` (a different binary), which can trigger a
   one-time macOS access dialog; "Always Allow" suppresses it thereafter. This
   is macOS ACL behaviour and is unavoidable without shipping a co-signed,
   access-group-sharing CLI binary. A declined prompt → the CLI falls back to
   the (empty) file secret and auth fails until allowed.
2. **Secret on argv in the rotate write path.** `security add-generic-password`
   has no stdin password option, so `writeKeychainApiKey` passes the new secret
   on argv, briefly visible to `ps`. Scoped to the rare desktop-managed
   `keys rotate` path only; the read path puts nothing sensitive on argv.
3. **Linux/cloud cleartext.** Future hardening could encrypt profiles.json at
   rest with an OS-bound key (libsecret/DPAPI-wrapped DEK) so the non-macOS
   canonical file is ciphertext. Out of scope for E4.4.

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
