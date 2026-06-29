# Zero → first-deploy onboarding (E5)

**Status:** Decision (SPIKE E5.0). No implementation — this is the design E5.1 (CLI),
E5.2 (desktop bring-up), and E5.3 (link + first-deploy hand-off) build against. Sits on
the microVM-only world after Epic 1 (bare k3d deleted) and the in-VM api-server +
`GET /api/v1/workloads` / `/api/v1/pods/:name/logs` from Epic 4
(`packages/api-server/src/main.ts:57`, `routes/workloads/index.ts:36,73`).

> **OWNER DECISION (2026-06-28) — supersedes the command-name recommendation below.**
> The onboarding command is **`appliance init`**, not `appliance start`. Wherever this
> doc says `appliance start` / `appliance-start.ts`, read **`appliance init`** / a
> reconciled `appliance-init.ts`. E5.1 MUST reconcile with the existing
> `appliance init` / `appliance login` cloud-credential flow: **`appliance init`
> defaults to local microVM onboarding** (boot → bootstrap in-VM api-server → adopt
> profile → ready → guided first deploy); the existing remote/cloud credential setup is
> preserved via explicit remote args (e.g. `appliance init --remote <url>`) and/or
> `appliance login`. Manager-resolved sibling forks: deploy hand-off is interactive
> `Y/n` in a TTY (print-only in CI/non-TTY); `doctor --fix` runs as a prefix with the
> macOS dev-binary signing step **prompted, not blind**; extract `runUp` to a shared
> util; `init` is **local-first** (cloud stays `appliance bootstrap`, not subsumed).

## Premise

Getting from a fresh machine to a live URL is currently a 4-command scavenger hunt on
the CLI and a dead-ends-at-the-dashboard click path in the desktop. Everything the happy
path needs **already exists** — it's just unsequenced and unnamed. E5 wraps it into **one
CLI command** and **one desktop click**, then **guides** the user into their first deploy
so they never have to discover `appliance app setup` / the deploy wizard on their own.

The bring-up itself is already a single function: `appliance vm up` boots the microVM,
waits for its k3s endpoint, delivers + bootstraps the in-VM api-server, and saves the
`microvm` credential profile (`packages/cli/src/appliance-vm.ts:130-276`, esp. `runUp`
at `:161`, `bootstrapInClusterApiServer` `:245`, `saveCredentials` `:252`). The Rust
engine already publishes structured bring-up phases (`packages/vm/src/bringup.rs:23-52`:
`Media → Booting → Network → Cluster → Ready`/`Failed`), surfaced to the desktop as
`MicroVmStatus.phase` (`packages/app/src/lib/host.ts:323,338`). The desktop already has a
one-click "Set up local runtime" on first launch (`packages/app/src/pages/dashboard.tsx:369`
→ navigates to `/bootstrap/run` with `{ mode: 'microvm' }`). And `appliance deploy`
already find-or-creates the project + environment, builds, pushes, polls, prints the URL,
and writes `link.json` (`packages/cli/src/appliance-deploy.ts:362,414-415,457,334`).

E5 is therefore **orchestration + sequencing + a hand-off**, not new runtime machinery.

## Today's fragmentation (verified)

| Surface | Step                                                                            | Where                                                      |
| ------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| CLI     | `appliance doctor [--fix]` preflight                                            | `appliance-doctor.ts:25`, `utils/preflight.ts:370`         |
| CLI     | `appliance vm up` (boot VM + bootstrap api-server + mint `microvm` profile)     | `appliance-vm.ts:130,161`                                  |
| CLI     | `appliance app setup` / `appliance setup` (pick/create project+env, write link) | `appliance-app.ts:46-159`, shortcut `appliance.ts:147-151` |
| CLI     | `appliance deploy` (build + push + deploy + URL)                                | `appliance-deploy.ts:362`                                  |
| Desktop | First-run "Set up local runtime" → `/bootstrap/run`                             | `dashboard.tsx:369-405`                                    |
| Desktop | `MicroVmProgress` (single node, text log) → "Open dashboard"                    | `bootstrap/progress.tsx:358-494`                           |
| Desktop | `LocalRuntimeDeployPage` 3-step deploy wizard                                   | `local-runtime/deploy.tsx:42`                              |

Gaps the user hits:

1. **No single entry on the CLI.** `doctor --fix` and `vm up` are separate, and `vm up`
   is filed under the VM-management noun (`vm`), not where a newcomer looks.
2. **`init` / `login` are a red herring for local.** They're interactive credential flows
   for cloud / BYO api-servers (`appliance-init.ts`, `appliance-login.ts`); the microVM
   path needs neither — `vm up` already mints + saves the profile.
3. **Desktop bring-up doesn't use its own structured phases.** `MicroVmProgress` renders
   _one_ glyph labelled "VM boot + api-server" fed by raw streamed text
   (`progress.tsx:391,427-433`), even though `Media→…→Ready` is already plumbed through
   `MicroVmStatus.phase`. A user can't tell "downloading" from "k3s wedged".
4. **The desktop dead-ends at the dashboard.** After "ready" the only CTA is "Open
   dashboard" (`progress.tsx:470`), which (with no projects) shows `EmptyProjects` —
   a CLI snippet, not a button (`dashboard.tsx:285-297`). The deploy wizard at
   `/local-runtime/deploy` exists but the user has to find it.
5. **`appliance app setup` is a hunt.** Nothing routes the user to project-linking; yet
   `deploy` already does the find-or-create + link, so `setup` is optional for first-run.

---

## 1. The single CLI command — **recommend `appliance start`** (KEY FORK)

> **FORK A (the one to confirm):** does onboarding reuse `appliance up`, or get its own
> verb? **Recommendation: a new top-level `appliance start`.** Justification below.

`appliance up` is **already taken** and means something deliberately different: run _this
repo's own_ container definition (Dockerfile/compose/devcontainer) in the in-guest dockerd
sandbox — _"It is **not** k3s; nothing here touches the api-server bootstrap path"_
(`docs/up.md:7`, impl `appliance-up.ts`, registered `appliance.ts:126`). Onboarding does
the **opposite**: it boots the k3s/api-server runtime and adopts its profile. Overloading
`up` to also mean "boot the cluster" would (a) collide with the documented sandbox
contract, (b) create a "is this starting my app or the runtime?" ambiguity, and (c) fight
`up`'s cwd-project detection (`up` in an empty dir already errors "no Dockerfile/compose",
`appliance-up.ts:69-74`). Reject reusing `up`.

`appliance init` (`appliance.ts:74`) and `appliance login` (`:98`) are taken by the
interactive cloud/BYO credential flow — reusing either collides and mislabels the local
path. Reject.

**`appliance start`** is unclaimed, reads as "start Appliance" (the runtime), greps
cleanly, and pairs with the existing `appliance vm stop`. It is a thin **orchestrator**:

```
appliance start [--name <vm>] [--no-deploy] [-y]
```

1. **Preflight + auto-fix** — run `runPreflight()` and `runFixes()` (`utils/preflight.ts:370,399`).
   Fail-fast on any hard `fail` that auto-fix can't clear, printing the existing checklist
   with exact remediations (`appliance-doctor.ts:59-101`). See §4 for the expanded fixes.
2. **Boot + adopt** — call the **same `runUp()`** path `appliance vm up` uses
   (`appliance-vm.ts:161`): boot the default `appliance` VM with live phases, wait for k3s
   - the in-VM registry, deliver + bootstrap the api-server, save the `microvm` profile.
     Idempotent: `runUp` already keeps existing creds when they still authenticate
     (`appliance-vm.ts:228-243`).
3. **Hand-off** — print the next step, and if cwd is a deployable project, **offer to run
   the first deploy now** (§5).

`appliance vm up` stays as the lower-level / multi-VM / power-user command (`--name`,
`--cpus`, `--memory`); `start` is the front door that wraps it for the default VM and adds
the doctor prefix + deploy hand-off. No behavior of `vm up` changes.

### Happy path (CLI)

```
$ appliance start
Appliance doctor — fixing what's safe…
  ✓ Container runtime (Docker)           Docker 27.x
  ✓ kubectl, crane                       installed
  ✓ Ports 8081 / 6443 / 5052 free
  ! api-server image not pulled       →  fixed: pulled ghcr.io/appliance-sh/api-server:<v> (linux/arm64)
  ✓ macOS code-signing                   published binary is signed

Starting microVM "appliance"…
  » preparing boot media
  » booting guest
  » guest network up (10.0.0.5)
  » starting k3s (first boot pulls images — can take a few minutes)
  ✓ cluster ready
» delivering api-server image into the VM registry
✓ api-server bootstrapped; credentials saved to profile microvm

MicroVM runtime 'appliance' is up.
  API server:  http://api.appliance.localhost:8081
  Ingress:     http://*.appliance.localhost:8081
  Profile:     microvm

Next — deploy your first app:
  → appliance deploy            (run it from your app's directory)
```

The phase lines are the `bringup.rs` labels (`:43-52`) the engine already prints; the
final banner is `runUp`'s existing output (`appliance-vm.ts:262-266`). Everything above
"Next —" exists today; E5.1 adds the `doctor` prefix and the hand-off footer.

---

## 2. Desktop "Get started" — reuse the structured bring-up phases (E5.2)

The one-click entry already exists and is correct: first launch with no cluster on a
shell that can sandbox (`localRuntimeCapabilities`, `lib/local-runtime.ts:20`) shows
`FirstRunWelcome` with a single **"Set up local runtime"** button that navigates straight
to `/bootstrap/run` with `{ mode: 'microvm' }` — no picker, no form (`dashboard.tsx:369-405`).
Keep this. (The mode-picker / VM-name form in `bootstrap/wizard.tsx` stays for the
"More options" / multi-VM / AWS paths.)

What E5.2 changes is **`MicroVmProgress`** (`bootstrap/progress.tsx:358`): today it renders
_one_ `PhaseCard` ("VM boot + api-server", `:427-433`) driven by raw text lines from
`vmHost.instance(name).up()` (`:391`). Replace the single node with the **five-stage
ladder the engine already reports**, reusing the existing `PhaseCard` component (`:504`):

```
Media → Booting → Network → Cluster → Ready
```

Source the live stage from `MicroVmStatus.phase` (`lib/host.ts:338`,
`MicroVmPhase` `:323`) by polling `host.vm.instance(name).status()` (`:443`, channel
`microvm_status`, `desktop/src/host.ts:225`) on an interval while `up()` runs, mapping each
`MicroVmPhase` to a `PhaseCard` state (`pending`/`running`/`completed`/`failed`). The raw
event log stays underneath as the detail drawer (`progress.tsx:436-458`). A `Failed` phase
carries `detail` (`bringup.rs:60-63`) → render it as the card's error + keep the existing
Retry button (`progress.tsx:482-490`).

Optionally gate the boot on `host.local.preflight()` (`lib/host.ts:630`) the same way the
CLI runs `doctor` first, surfacing a "Start runtime" button when colima is startable
(`startContainerRuntime`, `lib/host.ts:650`) — the desktop equivalent of `doctor --fix`.

No change needed to `desktop/src/host.ts` (the `microvm_status`/`microvm_up` channels
already stream and already expose `phase`) or to the Rust engine (phases already
published). E5.2 is **app-layer only** — important, because the concurrent `packages/vm`
guest.rs/shell work is out of scope here.

---

## 3. The guided hand-off — link + first deploy (E5.3)

The runtime being up is the _middle_, not the end. Both surfaces must lead the user into
their first deploy without them discovering `appliance app setup`.

**Key simplification:** `appliance deploy` already does find-or-create project, find-or-create
environment, and `writeLink()` (`appliance-deploy.ts:414-415,457`; helpers `:39,55`). So
**first-run never needs `appliance app setup`** — `setup`/`link` remain for the
link-without-deploying case only. The hand-off targets `deploy` directly.

**CLI (`appliance start` tail):** after the "up" banner, detect whether cwd is deployable
(an `appliance.{json,ts,js}` manifest, or a `Dockerfile`).

- In a TTY and deployable and not `--no-deploy`: prompt `Deploy <name> now? [Y/n]` and, on
  yes, run the deploy (spawn `appliance deploy` so its banner + URL print verbatim,
  `appliance-deploy.ts:323-345`).
- Otherwise print the exact next command (the footer in §1).
- Non-TTY / CI: never prompt — print the command only (mirrors `deploy`'s own non-TTY
  discipline, `appliance-deploy.ts:164-186`).

**Desktop:** two edits so "ready" flows into the existing deploy wizard
(`local-runtime/deploy.tsx:42`, which already does pick-folder → configure → build+deploy →
live URL `:266`):

1. `MicroVmProgress` success block (`progress.tsx:460-476`): make the **primary** CTA
   **"Deploy your first app"** → `/local-runtime/deploy`; demote "Open dashboard" /
   "Manage runtimes" to secondary.
2. `EmptyProjects` (`dashboard.tsx:285-297`): add a **"Deploy your first project"** button
   → `/local-runtime/deploy` alongside the CLI snippet, so a user who lands on the
   dashboard first still gets a button, not just copy-paste.

The wizard already gates on the selected microVM being ready (`readyToDeploy`,
`local-runtime/deploy.tsx:78`) and routes the image to the VM's in-VM registry — no change
needed there.

---

## 4. How `doctor --fix` folds in (E5.1)

`appliance start` runs the **existing** `runPreflight()` then `runFixes()`
(`utils/preflight.ts:370,399`) as its first step, blocking on unresolved hard `fail`s.
Today `runFixes` only pulls the api-server image (`:402-415`, `pullApiServerImage` `:421`).
E5.1 widens the **safe, non-trust-forking** auto-fixes:

- **api-server image** — `docker pull --platform linux/<hostArch>` the pinned published
  image (exists, `preflight.ts:421`; check `:296`). Makes first deploy offline-safe + fast.
- **helper binaries (crane, kubectl)** — for `autoInstallable` providers
  (`crane.ts:31`, `kubectl.ts:35`), drive `runInstall()` (`helper/src/install.ts:50`)
  instead of only printing the manual hint (`preflight.ts:193-201`). crane is required for
  image delivery into the VM registry (`appliance-vm.ts:344,402`).
- **container runtime** — when docker is installed but its daemon is down _and_ startable
  (colima), `runFixes` can `colima start` (status from `runtimeDaemonStatus()`,
  `helper/src/runtime.ts:186`; already detected at `preflight.ts:113-124`). Desktop parity:
  `host.local.startContainerRuntime()` (`lib/host.ts:650`).
- **macOS binary signing** — _guided, not blind_ (it forks a trust/identity decision). A
  published binary is already signed; only a **repo-built** `appliance-vm` is unsigned
  (`preflight.ts:337-358`). When `start` detects a repo-built unsigned binary it offers to
  run `packages/vm/scripts/sign-dev.sh` (the dev/ad-hoc cert) rather than running it
  unprompted. Off macOS / published binary: informational pass.

Errors stay **fail-fast + actionable**: every unfixable item already carries a one-line
remediation (`CheckResult.remediation`, `preflight.ts:67`), rendered by the existing
checklist printer. `start` exits non-zero before touching the VM if a hard check is still
red after fixes.

> **FORK C:** is dev-binary signing an auto-fix or a guided prompt, and should `start`
> always run `doctor --fix` (vs. only on failure)? Recommend: always run preflight; auto-fix
> image/bins/runtime; **prompt** for signing. Confirm the signing trust boundary.

---

## 5. Reused vs. new

**Reused as-is (no/near-zero change):**

- `runUp()` bring-up + api-server bootstrap + profile adoption (`appliance-vm.ts:161-276`).
- `bringup.rs` phase machine + labels (`packages/vm/src/bringup.rs:23-52`) — untouched.
- `runPreflight` / checklist renderer (`preflight.ts:370`, `appliance-doctor.ts:59`).
- `appliance deploy` find-or-create + build + link + URL (`appliance-deploy.ts`).
- Desktop `FirstRunWelcome` one-click (`dashboard.tsx:369`), `PhaseCard` (`progress.tsx:504`),
  `MicroVmStatus.phase` plumbing (`lib/host.ts:338`), `microvm_status`/`microvm_up`
  channels (`desktop/src/host.ts:225,232`), `LocalRuntimeDeployPage` wizard
  (`local-runtime/deploy.tsx`).

**New / modified:**

- CLI `appliance start` orchestrator + registration.
- Extended `runFixes` (crane/kubectl install, runtime start, dev-binary signing).
- Desktop: structured-phase rendering in `MicroVmProgress`; "Deploy your first app"
  hand-off CTA; `EmptyProjects` deploy-wizard button; optional preflight gate before boot.

---

## 6. File-set mapping

### E5.1 — CLI single command + doctor fold + deploy hand-off

- **NEW** `packages/cli/src/appliance-start.ts` — the orchestrator (preflight+fix → boot →
  hand-off). TTY-aware deploy offer.
- **EDIT** `packages/cli/src/appliance.ts` — register `start` in `SUBCOMMANDS` (`:34`);
  refresh the "Getting started" help block (`:202-206`) to lead with `appliance start`.
- **EDIT** `packages/cli/src/utils/preflight.ts` — widen `runFixes` (`:399`) per §4
  (likely an async variant to call `runInstall`).
- **REFACTOR (coordinate)** `packages/cli/src/appliance-vm.ts` — extract `runUp` (`:161`)
  into a shared `utils/microvm-up.ts` so `appliance-start.ts` and `appliance-vm.ts` call one
  copy instead of duplicating orchestration. _This is CLI TypeScript, not the `packages/vm`
  Rust the concurrent worker owns — low clobber risk, but flag it (FORK D)._
- **REUSE** `appliance-deploy.ts` (spawned for the hand-off), `utils/credentials.ts` /
  `profile-store.ts` (profile already saved by `runUp`).

### E5.2 — Desktop "Get started" with live bring-up phases

- **EDIT** `packages/app/src/pages/bootstrap/progress.tsx` — `MicroVmProgress` (`:358`):
  render the 5-stage `PhaseCard` ladder from polled `status().phase`; keep the event log as
  detail; surface `Failed.detail`.
- **EDIT (small)** `packages/app/src/pages/dashboard.tsx` — `FirstRunWelcome` (`:369`):
  optional preflight gate / "Start runtime" affordance before navigating.
- **REUSE** `packages/app/src/lib/host.ts` (`MicroVmPhase`/`MicroVmStatus.phase`,
  `:323,338`) and `packages/desktop/src/host.ts` channels — no change.

### E5.3 — Link + first-deploy hand-off

- **EDIT** `packages/app/src/pages/bootstrap/progress.tsx` — success CTA (`:460-476`) →
  primary "Deploy your first app" → `/local-runtime/deploy`.
- **EDIT** `packages/app/src/pages/dashboard.tsx` — `EmptyProjects` (`:285-297`): add a
  "Deploy your first project" button → `/local-runtime/deploy`.
- **EDIT** `packages/cli/src/appliance-start.ts` — the post-ready deploy offer/footer
  (so the CLI never points at `appliance app setup`).
- **REUSE** `packages/app/src/pages/local-runtime/deploy.tsx` (hand-off target) and
  `appliance-deploy.ts` (find-or-create + link already happen there).

---

## 7. Open forks (for the manager)

- **FORK A — naming (decide first):** `appliance start` (new top-level, **recommended**)
  vs. overloading `appliance up`. Reusing `up` collides with the documented sandbox
  contract (`docs/up.md:7`). Everything downstream assumes `start`.
- **FORK B — deploy hand-off:** does `start` _auto-run_ the first deploy in a deployable dir
  (interactive `Y/n` in a TTY, **recommended**) or only print the next command? CI/non-TTY
  is print-only either way.
- **FORK C — doctor/signing:** always run `doctor --fix` as the prefix (recommended);
  dev-binary signing **prompted**, not blind. Confirm the trust boundary.
- **FORK D — `runUp` extraction:** factor `runUp` out of `appliance-vm.ts` into a shared util
  so `start` doesn't duplicate it. CLI-TS only (not the concurrent `packages/vm` Rust), but
  flag the shared-file edit.
- **Scope:** `start` is **local-first** — cloud stays `appliance bootstrap`; `start` does
  not subsume AWS. (Confirm we're happy with that boundary.)
