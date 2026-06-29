# k3d Removal — keep/delete boundary (E1.0 spike)

Authoritative boundary for the E1.x build tasks. Each path below is classified
**DELETE** | **KEEP** | **DECOUPLE/RENAME** with the exact symbols. Execute
deletions in the [order](#deletion-order) given; do not re-decide classifications.

## Locked decision

- Delete bare **k3d** entirely. The **microVM** is the sole local runtime.
- macOS / Virtualization.framework is the only supported host today.
  Linux/Windows wait for the KVM/WSL2 backend — **no parallel k3d path** is kept
  to cover them. Owner has accepted that capability gap (see [Gaps](#accepted-capability-gaps)).

## Survivors — MUST NOT break (shared with BYO-k8s + cloud, not k3d-specific)

1. `KubernetesDeploymentService` (aliased `LocalContainerDeploymentService`) —
   `packages/infra/src/lib/local/LocalContainerDeploymentService.ts`. Generic
   k8s deploy engine; drives **both** `appliance-base-local` and
   `appliance-base-kubernetes`. KEEP whole; only its k3d image-import branch decouples.
2. `isKubernetesBase()` — `packages/sdk/src/models/appliance-base.ts`. Must keep
   returning **true** for `appliance-base-kubernetes`.
3. The `appliance-base-kubernetes` deploy path end-to-end (executor →
   `LocalContainerDeploymentService` → k8s API).

## Corrections to prior recon (verified against current code)

- **infra import-touchpoint is local, not via helper.** `maybeImportImage`
  (LocalContainerDeploymentService.ts:453) shells out directly with
  `execFileAsync('k3d', ['image','import',…])` (line 463). It does **not** call
  helper's `importImageToCluster`. Decouple inside the file.
- **The class is `KubernetesDeploymentService`**, exported under the
  back-compat alias `LocalContainerDeploymentService` (line 595-596). Keep the alias.
- **`kubeContextForCluster` / `registryNameForCluster` are NOT shared with the
  microVM.** `registryNameForCluster` is used only inside `cluster.ts` + its spec
  (k3d-internal). `kubeContextForCluster` returns `k3d-<name>` and is used only in
  the k3d **default branch** of `cluster-target.ts:125`. Both die with k3d. The
  genuinely shared helper surface is `api-server.ts` (bootstrap) + the
  `DEFAULT_LOCAL_*` naming/port constants + `runtime.ts`/`context.ts`/`install.ts`/
  `registry.ts`/`providers/{docker,kubectl,crane}.ts`.
- **infra `DEFAULT_LOCAL_NODEPORT_MIN/MAX`** are defined _locally_ in
  LocalContainerDeploymentService.ts:28-29 (not imported from helper) and feed
  `deterministicNodePort` for every k8s deploy. KEEP (rename-only).
- **preflight ports are already microVM-shaped.** `REQUIRED_PORTS`
  (preflight.ts:38) = 8081 ingress / 6443 k8s-API / **5052** in-VM registry — the
  k3d registry port (5050) is not probed. No port is k3d-specific. The k3d
  _binary_ check is not in preflight.ts; it comes from `k3dProvider` in
  `defaultProviders` (registry.ts:11). Deleting that provider removes the check.
- **Desktop workloads/logs + CLI logs/health are engine-routed shared surface.**
  `list_local_workloads`/`tail_local_pod_logs` route via
  `kube_target_args(input.engine,…)`; `cluster-target.ts` routes via the active
  profile. They have a k3d _default branch_ to remove, not a whole-file delete.

## Keep / delete table (by package)

### packages/cli

| Path                                                  | Symbols                                                                                                                 | Action                                                           |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/appliance-local.ts`                              | whole file (`status`/`up`/`stop`/`delete`/`exec`/`shell`/`runtime`/`install`/`update`)                                  | **DELETE**                                                       |
| `src/appliance.ts`                                    | `SUBCOMMANDS.local` entry (line 86-89); k3d wording in comment (line 7)                                                 | **DELETE** entry / **EDIT** comment                              |
| `src/utils/cluster-target.ts`                         | k3d default branch (lines 122-128, `kubeContextForCluster` import); microVM + `--kubeconfig`/`--context` override paths | **DECOUPLE** (drop k3d default; KEEP override+microVM)           |
| `src/utils/local-image.ts`                            | `importImageToCluster` fallback (lines 17,96-103), `appliance local status` hint (107)                                  | **DECOUPLE** (registry/crane push KEEP; drop k3d import)         |
| `src/utils/preflight.ts`                              | `REQUIRED_PORTS` (8081/6443/5052), kubectl/crane/docker checks                                                          | **KEEP**; **EDIT** "k3d" labels (lines 30-31,36-37,164,177,179)  |
| `src/appliance-deploy.ts`                             | `publishLocalApplianceImage` call (KEEP); `appliance local up` hint (line 385)                                          | **EDIT** hint                                                    |
| `src/appliance-logs.ts` / `appliance-deployment.ts`   | `resolveClusterTarget` consumers                                                                                        | **KEEP** (ride on cluster-target decouple); **EDIT** stray hints |
| `src/utils/errors.ts`                                 | `appliance local up`/`runtime start`/`k3d` remediation (lines 15,24,26,27,30)                                           | **EDIT** (point at `appliance vm`)                               |
| `src/utils/{errors,cluster-target,preflight}.spec.ts` | k3d-string cases                                                                                                        | **TRIM** k3d cases                                               |

### packages/helper

| Path                   | Symbols                                                                                                                                                                                                                                                                                                                                                                                | Action                                                                                                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/providers/k3d.ts` | `k3dProvider`                                                                                                                                                                                                                                                                                                                                                                          | **DELETE** file                                                                                                                                                  |
| `src/registry.ts`      | `k3dProvider` import + array entry (lines 3,11)                                                                                                                                                                                                                                                                                                                                        | **DELETE** entry                                                                                                                                                 |
| `src/cluster.ts`       | `startLocalCluster`, `stopLocalCluster`, `deleteLocalCluster`, `localClusterStatus`, `startExistingCluster`, `waitForNodesReady`/`allNodesReady`, `isWedgedStartFailure`, `ensureRegistry`, `probeRegistryUrl`, `importImageToCluster`, `clusterNameOrDefault`, `kubeContextForCluster`, `registryNameForCluster`, `LocalClusterOptions`/`LocalClusterStatus`, `NODE_READY_TIMEOUT_MS` | **DELETE**                                                                                                                                                       |
| `src/cluster.ts`       | `DEFAULT_LOCAL_CLUSTER_NAME`/`_NAMESPACE`/`_HOST_PORT`/`_REGISTRY_PORT` (`_NODEPORT_MIN/MAX` are k3d-only → delete)                                                                                                                                                                                                                                                                    | **KEEP** the 4 still consumed by `api-server.ts`/`cluster-target`/`appliance-vm` (relocate to a non-k3d module or keep a slim constants block); rename candidate |
| `src/api-server.ts`    | `importImageToCluster` call (lines 11,474-476) + `probeRegistryUrl` fallback (lines 12,84) + `DEFAULT_LOCAL_REGISTRY_PORT` (line 76)                                                                                                                                                                                                                                                   | **DECOUPLE** (microVM passes `registryUrl`+`kubeconfigPath`; drop k3d branches). File KEEP — shared bootstrap.                                                   |
| `src/index.ts`         | exports of every deleted symbol (lines 19-37)                                                                                                                                                                                                                                                                                                                                          | **DECOUPLE** (prune barrel)                                                                                                                                      |
| `src/cluster.spec.ts`  | `isWedgedStartFailure`, `registryNameForCluster` tests                                                                                                                                                                                                                                                                                                                                 | **DELETE/TRIM** with the fns                                                                                                                                     |
| `package.json`         | `k3d` keyword/desc if any                                                                                                                                                                                                                                                                                                                                                              | **EDIT**                                                                                                                                                         |

### packages/infra

| Path                                               | Symbols                                                                     | Action                                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/lib/local/LocalContainerDeploymentService.ts` | class `KubernetesDeploymentService` + alias; rollout/health/manifest        | **KEEP** (survivor)                                                    |
| same                                               | `maybeImportImage` (lines 453-476) `execFileAsync('k3d',…)`                 | **DECOUPLE** (gate off / make no-op for registry-only delivery)        |
| same                                               | `DEFAULT_LOCAL_*` (lines 18-29), `DEFAULT_LOCAL_HOSTNAME_SUFFIX`            | **KEEP** — used by BYO-k8s defaults; rename-for-clarity candidate only |
| `src/lib/controller.ts`                            | `case ApplianceLocal:` falls through to `ApplianceKubernetes` (lines 11-12) | **KEEP** (ApplianceLocal stays a deprecated alias)                     |

### packages/api-server

| Path                                          | Symbols                                                                         | Action                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `src/services/deployment-executor.service.ts` | `isKubernetesBase` + `LocalContainerDeploymentService` dispatch (lines 107-115) | **KEEP**; **EDIT** "local k3d" comment (line 108) only |

### packages/sdk

| Path                           | Symbols                                                                           | Action                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/models/appliance-base.ts` | `ApplianceBaseType.ApplianceLocal` + `applianceLocalInput` + `local` config block | **DECOUPLE/deprecate** — keep the enum value & schema (executor/infra still branch on it; deploys in flight) but mark deprecated; **isKubernetesBase MUST stay true for `appliance-base-kubernetes`** |
| same                           | `isKubernetesBase`, `getKubernetesParams`, `applianceKubernetesInput`             | **KEEP**                                                                                                                                                                                              |

### packages/desktop (Tauri Rust — `src-tauri/src/lib.rs`)

| Symbols                                                                                                                                                                                                                                                                                                                                                     | Action                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `local_cluster_status`, `start_local_cluster`, `stop_local_cluster`, `delete_local_cluster`                                                                                                                                                                                                                                                                 | **DELETE**                                                                             |
| `local_runtime_status`, `start_local_runtime`, `stop_local_runtime`, `delete_local_runtime`                                                                                                                                                                                                                                                                 | **DELETE** (k3d lifecycle; ignore `engine` field)                                      |
| `local_preflight`, `local_helper_install`                                                                                                                                                                                                                                                                                                                   | **KEEP** (shared); **EDIT** to drop k3d provider                                       |
| `start_container_runtime`                                                                                                                                                                                                                                                                                                                                   | **KEEP** (docker/colima)                                                               |
| `bootstrap_in_cluster_api_server`                                                                                                                                                                                                                                                                                                                           | **KEEP** (shared; microVM passes kubeconfig)                                           |
| `list_local_workloads`, `tail_local_pod_logs`                                                                                                                                                                                                                                                                                                               | **DECOUPLE** (drop the omitted/k3d `kube_target_args` branch; keep `engine="microvm"`) |
| `build_and_import_image`                                                                                                                                                                                                                                                                                                                                    | **DECOUPLE** (drop `k3d image import` legacy path; keep registry push)                 |
| helpers: `registry_name_for_cluster`, `ensure_registry`, `probe_registry_url`, `resolve_runtime_config`(k3d bits), `find_local_runtime_cluster`/`register_local_runtime_cluster`, `is_wedged_start_failure`, `cluster_name_or_default`, the k3d `DEFAULT_LOCAL_*` consts, `LocalClusterInput`/`LocalClusterStatus`/`LocalRuntimeInput`/`LocalRuntimeStatus` | **DELETE** (those used only by deleted cmds)                                           |
| `#[cfg(test)] detects_wedged_start_from_real_k3d_error` / `ignores_unrelated_start_failures` (line 5147+)                                                                                                                                                                                                                                                   | **DELETE**                                                                             |
| `invoke_handler!` list (lines 5085-5138)                                                                                                                                                                                                                                                                                                                    | **DECOUPLE** (remove the 8 deleted command idents)                                     |

### packages/desktop (TS bindings)

| Path               | Symbols                                                                                                                                                            | Action                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `src/host.ts`      | invokes `local_cluster_status`/`start_local_cluster`/`stop_local_cluster`/`delete_local_cluster` + `*_local_runtime` (lines 182-209)                               | **DELETE** methods              |
| `src/host.ts`      | `build_and_import_image` (231)                                                                                                                                     | **DECOUPLE**                    |
| `src/host.ts`      | `local_preflight`/`local_helper_install`/`start_container_runtime`/`read_appliance_manifest`/`bootstrap_in_cluster_api_server`/`pickDirectory` + whole `vm:` block | **KEEP**                        |
| `src/mock-host.ts` | k3d cluster/runtime mocks + fixtures (≈ lines 101-123,160-240,264-311,466-531)                                                                                     | **DELETE**                      |
| `src/mock-host.ts` | shared mocks (`preflight`/`installPrereq`/`pickDirectory`/`readApplianceManifest`/`bootstrapInClusterApiServer`) + `buildAndImportImage`                           | **KEEP** / **DECOUPLE** (build) |

### packages/app

| Path                                                                            | Symbols                                                                                                                   | Action                                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/lib/host.ts`                                                               | `LocalRuntimeHost`: `status`/`start`/`stop`/`delete` + `LocalClusterInput`/`LocalClusterStatus` types                     | **DELETE**                                                                    |
| same                                                                            | `runtimeStatus`/`startRuntime`/`stopRuntime`/`deleteRuntime` (k3d-backed via desktop)                                     | **DELETE**                                                                    |
| same                                                                            | `listWorkloads`/`tailPodLogs` (engine param)                                                                              | **DECOUPLE** (microVM only)                                                   |
| same                                                                            | `preflight`/`installPrereq`/`startContainerRuntime`/`pickDirectory`/`readApplianceManifest`/`bootstrapInClusterApiServer` | **KEEP**                                                                      |
| same                                                                            | `buildAndImportImage`                                                                                                     | **DECOUPLE** (registry-only)                                                  |
| `src/lib/local-runtime.ts`                                                      | `LocalRuntimeCapabilities.canHost`                                                                                        | **DECOUPLE** (`canHost`→always false / remove); `canSandbox` KEEP             |
| `src/pages/bootstrap/wizard.tsx`                                                | `LocalWizardValues`, k3d advanced-options block, `mode:'local'` submit                                                    | **DELETE**; `ModePicker`/`LocalRuntimeForm` shell **DECOUPLE** (microVM only) |
| `src/pages/bootstrap/progress.tsx`                                              | `LocalProgress` + `mode==='local'` branch                                                                                 | **DELETE**; `MicroVmProgress`/`AwsProgress` **KEEP**                          |
| `src/pages/local-runtime/index.tsx`                                             | `k3dCard`, k3d start/stop/delete mutations, port-conflict gate                                                            | **DELETE**; `EnginesSection`/`MicroVmPanel` **KEEP**                          |
| `src/pages/local-runtime/deploy.tsx`                                            | `runtimeStatus().config.registryUrl` k3d fallback (≈225-226)                                                              | **DECOUPLE**; page **KEEP**                                                   |
| `src/pages/local-runtime/terminal-drawer.tsx`                                   | engine routing                                                                                                            | **KEEP** (microVM); **EDIT** comment                                          |
| `src/components/layout/cluster-switcher.tsx`                                    | `LOCAL_RUNTIME_CLUSTER_ID`/`engineLabel` "on host" branch                                                                 | **DECOUPLE**                                                                  |
| `src/pages/connect.tsx` (line ~125), `src/pages/dashboard.tsx` (lines ~398,446) | `appliance local up` / "k3d cluster on this machine" copy                                                                 | **EDIT**                                                                      |

### repo root / docs

| Path                                                          | Action                               |
| ------------------------------------------------------------- | ------------------------------------ |
| `examples/demo-local-runtime.sh`                              | **DELETE**                           |
| `README.md` (local-runtime command table + section, ~99-167)  | **EDIT/DELETE** k3d section          |
| `ARCHITECTURE.md` ("Local cluster lifecycle (k3d)", ~189-270) | **EDIT/DELETE**                      |
| `docs/microvm.md` (k3d comparison, lines 3,9-25,76,81)        | **EDIT** (reframe k3d as removed)    |
| `docs/sandbox.md` (line 73), `docs/up.md` (line 55)           | **EDIT** `appliance local stop` hint |

## Deletion order (never leaves the tree red)

Delete leaf consumers before the shared modules they import, with a BYO-k8s
checkpoint after each layer. helper's k3d functions are imported only by
`appliance-local.ts`; the Tauri commands only by desktop/app — so surface first.

1. **CLI surface** — delete `appliance-local.ts`, drop `SUBCOMMANDS.local`,
   decouple `cluster-target.ts`/`local-image.ts`, edit hint strings, trim CLI specs.
   _Checkpoint:_ `nx build cli` green; `appliance vm`, `appliance deploy`,
   `appliance logs --kubeconfig …` still compile/run.
2. **Desktop Rust + TS bindings** — remove the 8 Tauri commands + dead helpers +
   k3d Rust test, prune `invoke_handler!`, delete `host.ts`/`mock-host.ts` k3d
   methods, decouple `build_and_import_image` + workloads/logs.
   _Checkpoint:_ `cargo test -p appliance-desktop` + `nx build desktop` green.
3. **App frontend** — delete `LocalProgress`/`LocalWizardValues`/`k3dCard` + k3d
   host methods/types; simplify wizard/progress/local-runtime/dashboard/connect.
   _Checkpoint:_ `nx build app` green; microVM bootstrap + deploy UI renders.
4. **helper package** — delete `providers/k3d.ts`, drop from `registry.ts`,
   delete the k3d half of `cluster.ts` (keep the 4 `DEFAULT_LOCAL_*` constants),
   decouple `api-server.ts`, prune `index.ts`, trim `cluster.spec.ts`.
   _Checkpoint:_ `nx build helper` + dependents green (nothing imports the
   deleted symbols — verified: only `appliance-local.ts`, already gone).
5. **infra / sdk / api-server / docs** — decouple infra `maybeImportImage`,
   deprecate `ApplianceLocal` in sdk (keep `isKubernetesBase`), edit executor
   comment, delete `demo-local-runtime.sh`, edit README/ARCHITECTURE/docs.
   _Checkpoint:_ full [BYO-k8s regression](#byo-k8s--cloud-regression-test).

## BYO-k8s / cloud regression test (prove a kubernetes-base deploy still works)

Run after step 4 and again after step 5. The deploy path under test
(`executor → isKubernetesBase → KubernetesDeploymentService`) must be untouched.

1. **Unit/contract:** `nx test infra` and `nx test sdk` — keep
   `LocalContainerDeploymentService.spec.ts` (Deployment/Service/Ingress render,
   `deterministicNodePort`, refuses non-k8s base) and
   `appliance-base.spec.ts` (`isKubernetesBase` true for both k8s variants) green.
2. **Live BYO deploy:** against any reachable cluster, build an
   `appliance-base-kubernetes` base (inline `kubeconfig` or `server`+`token`,
   a `dataDir`, no k3d), then run an appliance deploy → assert Deployment +
   Service + Ingress created in the namespace, rollout Ready, reported URL
   resolves; `destroy` removes the trio idempotently. The microVM runtime
   (which is `appliance-base-kubernetes` under the hood, kubeconfig + in-VM
   registry) doubles as the live exercise: `appliance vm up` → `appliance deploy
--profile microvm` → reachable URL → `appliance destroy`.
3. **Cloud smoke (unaffected):** `nx test api-server` deployment-executor specs
   green; confirm the AWS (`appliance-base-aws-*`) Pulumi dispatch in
   `controller.ts` is unchanged.

## Accepted capability gaps

Owner-accepted (no mitigation in this epic):

- **Non-macOS hosts lose the local runtime** until the KVM/WSL2 microVM backend
  lands. No k3d fallback for Linux/Windows in the interim.
- **CI / headless runners** that ran `appliance local up` (k3d-in-Docker, no
  nested virt needed) lose that path; CI local-deploy coverage must move to a
  real BYO `appliance-base-kubernetes` cluster or wait for the KVM backend.
- **Cold-boot speed / footprint:** a microVM boots slower and costs more
  resources than k3d-in-an-existing-Docker-daemon.
- **k3d image-import convenience** (`k3d image import`, no registry) is gone;
  local image delivery is registry-only (in-VM registry / crane push).

## E1.1–E1.5 ownership (non-overlapping file sets)

- **E1.1 — CLI:** `packages/cli/src/appliance-local.ts` (delete),
  `appliance.ts` (entry), `utils/cluster-target.ts`, `utils/local-image.ts`,
  `utils/preflight.ts`, `utils/errors.ts`, `appliance-deploy.ts`,
  `appliance-logs.ts`, `appliance-deployment.ts`, + matching `*.spec.ts`.
- **E1.2 — Desktop:** `packages/desktop/src-tauri/src/lib.rs` (commands +
  helpers + Rust tests + `invoke_handler!`), `packages/desktop/src/host.ts`,
  `packages/desktop/src/mock-host.ts`.
- **E1.3 — App frontend:** `packages/app/src/lib/host.ts`,
  `packages/app/src/lib/local-runtime.ts`, `pages/bootstrap/wizard.tsx`,
  `pages/bootstrap/progress.tsx`, `pages/local-runtime/*`,
  `components/layout/cluster-switcher.tsx`, `pages/connect.tsx`,
  `pages/dashboard.tsx`.
- **E1.4 — helper:** `packages/helper/src/providers/k3d.ts` (delete),
  `registry.ts`, `cluster.ts`, `api-server.ts`, `index.ts`, `cluster.spec.ts`,
  `package.json`.
- **E1.5 — infra/sdk/api-server/docs:**
  `packages/infra/src/lib/local/LocalContainerDeploymentService.ts` (decouple),
  `infra/src/lib/controller.ts` (comment), `packages/sdk/src/models/appliance-base.ts`
  (deprecate ApplianceLocal), `packages/api-server/src/services/deployment-executor.service.ts`
  (comment), `examples/demo-local-runtime.sh` (delete), `README.md`,
  `ARCHITECTURE.md`, `docs/microvm.md`, `docs/sandbox.md`, `docs/up.md`.

> Boundary note: E1.4 must merge **after** E1.1 (helper's deleted k3d fns are
> imported only by `appliance-local.ts`). E1.2/E1.3 are independent of E1.4 and
> of each other. E1.5's sdk/infra changes are last so `isKubernetesBase` +
> `LocalContainerDeploymentService` stay green through the whole sequence.

## Open fork for owner/security sign-off

After k3d removal, `appliance logs` / `appliance deployment health` / desktop
workloads have **no local default target** (today `cluster-target.ts:125` and the
Rust `kube_target_args` fall back to the `k3d-appliance-local` context). Decide:
(a) require an explicit `--kubeconfig`/`--context` (BYO) when no microVM profile
is active, or (b) default to the microVM kubeconfig. Recommend (b) for the
zero-config local story. Secondary: keep `appliance local` as a one-line
deprecation stub redirecting to `appliance vm`, or remove it outright (locked
decision implies removal).
