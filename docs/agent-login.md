# Agent login — interactive OAuth + the agent-agnostic auth-mode seam (Phase 5)

**Status:** Design (L0 spike). **Scope:** the design L1–L3 build to — it adds
**interactive "Sign in with Claude" (subscription OAuth) login** alongside the
existing API-key login, and generalizes the credential into an **agent-agnostic
auth-mode abstraction** so other CLI agents drop in later. **Branch:**
`feat/phase5-agent-sandboxes`. **Builds on:** the shipped Phase 5 broker
([docs/agent-sandbox.md](agent-sandbox.md)) — read it first; this doc only adds a
**second auth mode** to that exact broker, with the same guarantees.

This is **design, not feature code.** No runner/broker/desktop behavior changes
until L1–L3 implement it.

## 0. Headline + the hard ToS constraint (read first)

Today the broker injects an **Anthropic API key** as `X-Api-Key`
(`docs/agent-sandbox.md` §3). This design adds the **interactive subscription
path**: the user signs in with their Claude **Pro/Max/Team/Enterprise** account
and we broker a **one-year OAuth token** (prefix `sk-ant-oat01-`) as
`Authorization: Bearer …` instead. Everything else about the broker is
unchanged — same egress proxy, same `creds.rs`/`mitm.rs`, same fail-closed, same
MITM scope, same peer-pin. The token, like the key, **never enters the VM**.

> **ToS constraint — bake in, do not design around (Feb 2026).** Subscription
> OAuth tokens are intended for **Claude Code / claude.ai direct use ONLY**.
> This design is acceptable **only because we run the `claude` binary
> _directly_ inside the VM** and the broker merely swaps the auth header on
> _Claude Code's own_ outbound calls to `api.anthropic.com`. We do **NOT**
> expose a model-API endpoint, **NOT** wrap/proxy/rewrite the Anthropic model
> API as a third-party service, and **NOT** resell access. The broker is a
> header-injection point on the agent's own traffic, not an API gateway.
> **Any future work that turns this into an API-as-a-service (a listener that
> accepts arbitrary model requests and forwards them under the user's
> subscription token) is out of bounds.** L1's "Sign in with Claude" copy must
> carry a short version of this caveat.

> **Why a one-year token ⇒ no refresh plumbing.** `claude setup-token` returns a
> **one-year** token. We deliberately do **NOT** use the short-lived (~60 min)
> `/login` subscription tokens, so there is **no refresh/rotation machinery** in
> this design — the token is a long-lived opaque secret handled exactly like the
> API key (host store → helper → proxy). Re-login when it expires.

## 1. The auth-mode abstraction (the "other agents" seam)

The Phase 5 adapter (`packages/cli/src/utils/agent.ts`, `AgentAdapter`) already
anticipated this: §11 of the sandbox doc noted "if a gateway-bearer flow is
chosen, the header flips to `authorization` and the placeholder var changes."
This design makes that a **first-class, per-adapter declaration** instead of a
hard-coded single mode.

Each adapter declares one or more **auth modes**. A mode is everything the
runner + broker need to wire a credential of a given kind end to end:

```ts
/** One way an agent authenticates. The runner selects a mode by the kind of
 *  credential the user stored host-side (api-key vs oauth), then derives the
 *  broker cred-rule header, the in-guest placeholder env, and the host login
 *  command from it. (docs/agent-login.md §1) */
export interface AuthMode {
  /** Which credential this mode consumes. The host store tags every stored
   *  secret with its kind; the runner matches that tag to a mode. */
  kind: 'api-key' | 'oauth';
  /** The wire header the agent CLI emits its credential on, and the header
   *  the broker rewrites host-side. */
  header: 'x-api-key' | 'authorization';
  /** Auth-scheme prefix for the header value (OAuth bearer). When set, the
   *  host `print-key` helper emits `"<scheme> <secret>"`; when unset it emits
   *  the bare secret. So the proxy stays scheme-agnostic — see §3. */
  scheme?: 'Bearer';
  /** The in-guest env var that carries the (placeholder) credential so the CLI
   *  starts and emits `header`. Exactly ONE auth env is set per launch — the
   *  one for the selected mode — to avoid the CLI's credential-precedence
   *  chain picking a different header (§3). */
  env: string; // 'ANTHROPIC_API_KEY' | 'CLAUDE_CODE_OAUTH_TOKEN'
  /** Host-side interactive login that yields this credential (OAuth only).
   *  Run on the HOST; prints a URL the user opens in their own browser;
   *  returns the long-lived token on stdout. Absent for api-key (the user
   *  pastes/pipes the key). */
  loginCmd?: string; // 'claude setup-token'
  /** Inert, syntactically-shaped placeholder put in `env` in-guest. The CLI
   *  needs *a* credential present to start + emit the header; the proxy
   *  overwrites it host-side. Capturing it buys an attacker nothing. */
  placeholder: string;
}

export interface AgentAdapter {
  type: string;
  installCmd: string;
  launchArgv(opts: AgentLaunchOpts): string[];
  /** The single API host the broker injects on (MVP: one host per adapter). */
  apiHost: string; // 'api.anthropic.com'
  /** The auth modes this agent supports. The runner picks by stored cred kind;
   *  if the user stored a kind the adapter doesn't declare, the launch errors
   *  with an actionable message. */
  authModes: AuthMode[];
  /** Agent-specific non-auth runtime env (e.g. CLAUDE_CODE_CERT_STORE). */
  runtimeEnv?: Record<string, string>;
  parseResult?(stdout: string): { ok: boolean; summary?: string };
}
```

This **replaces** the adapter's current `credHosts` + `placeholderEnv` (a
single hard-coded `x-api-key` rule + a single `ANTHROPIC_API_KEY` placeholder)
with `apiHost` + `authModes`. The runner builds the cred rule and the in-guest
env **from the selected mode** rather than from fixed fields.

### Claude Code — declares BOTH modes

```ts
export const claudeCodeAdapter: AgentAdapter = {
  type: 'claude-code',
  installCmd: 'command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code >/dev/null',
  launchArgv(opts) {
    /* …unchanged from today (interactive `claude [task]`; autonomous
       `claude -p <task> --output-format json --dangerously-skip-permissions`) */
  },
  apiHost: 'api.anthropic.com',
  authModes: [
    {
      kind: 'api-key',
      header: 'x-api-key',
      env: 'ANTHROPIC_API_KEY',
      placeholder: 'sk-ant-appliance-proxy', // existing inert placeholder
    },
    {
      kind: 'oauth',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'CLAUDE_CODE_OAUTH_TOKEN',
      loginCmd: 'claude setup-token', // host-side; one-year token to stdout
      placeholder: 'sk-ant-oat01-appliance-proxy', // inert oauth-shaped placeholder
    },
  ],
  runtimeEnv: { CLAUDE_CODE_CERT_STORE: 'bundled,system' },
  parseResult(stdout) {
    /* …unchanged */
  },
};
```

Credential precedence inside Claude Code is
`ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > `apiKeyHelper` >
`CLAUDE_CODE_OAUTH_TOKEN` > interactive `/login`. **This is why exactly one auth
env is set per launch:** in OAuth mode we set **only** `CLAUDE_CODE_OAUTH_TOKEN`
(and must NOT also set `ANTHROPIC_API_KEY`, which outranks it and would make the
CLI emit `x-api-key` instead of the Bearer we broker). The `env` field on the
selected mode is the single source of truth for which var the runner sets.

### A FUTURE agent plugging in — GitHub Copilot CLI (worked example)

No transport, broker, or runner change — just a new adapter object with its own
`authModes`. Copilot CLI is OAuth-only (a `Bearer` token from `copilot login`):

```ts
export const copilotAdapter: AgentAdapter = {
  type: 'copilot',
  installCmd: 'command -v copilot >/dev/null 2>&1 || npm install -g @github/copilot >/dev/null',
  launchArgv(opts) {
    /* copilot's interactive / -p equivalents */
  },
  apiHost: 'api.githubcopilot.com', // the host its model calls hit (illustrative)
  authModes: [
    {
      kind: 'oauth',
      header: 'authorization',
      scheme: 'Bearer',
      env: 'COPILOT_GITHUB_TOKEN',
      loginCmd: 'copilot login', // host-side interactive sign-in
      placeholder: 'ghu_appliance_proxy', // inert
    },
  ],
  runtimeEnv: {},
};
```

The runner does the identical work it does for Claude Code: pick the mode whose
`kind` matches the stored credential, write one `creds.rs` rule
`{ host: apiHost, inject: true, capture: false, header: mode.header }` with the
`print-key` helper, set the single in-guest env `mode.env=mode.placeholder`, turn
MITM on. The only per-agent inputs are the strings in `authModes` — that is the
whole seam.

## 2. L1 — login UX contract (`appliance agent login` becomes a mode picker)

**Build contract (one line):** `appliance agent login` gains a **mode picker —
API key (existing) OR "Sign in with Claude" (subscription OAuth)** — the OAuth
path runs `claude setup-token` on the **host**, surfaces the printed URL, captures
the one-year `sk-ant-oat01-` token, and stores it host-side **tagged `kind:'oauth'`**;
`print-key` then returns the right wire value per stored kind.

### The two paths

1. **API key** (today's flow, `appliance-agent.ts` `login`): prompt (hidden) or
   stdin → `writeAgentKey(value, 'api-key')`. Unchanged except for the new
   `kind` tag (§5).

2. **Sign in with Claude** (new): run the selected mode's `loginCmd`
   (`claude setup-token`) **on the host**, with its TTY inherited so the user
   sees the URL and the browser opens, while we **also capture stdout**. On exit,
   extract the token by grepping captured output for the `sk-ant-oat01-` prefix
   (robust to whether the URL goes to stderr/tty and the token to stdout), then
   `writeAgentKey(token, 'oauth')`. **`claude setup-token` runs host-side, never
   in the VM**, and **requires `claude` installed on the host** + a Pro/Max/
   Team/Enterprise subscription — both are precondition checks with actionable
   errors. The token is returned to us and stored; it is **not** saved by
   `setup-token` anywhere else.

Surface selection as either an interactive prompt (`API key` / `Sign in with
Claude`) or explicit flags: `appliance agent login --oauth` vs
`appliance agent login [--key <v>]`. Both end at the same host store.

### How `print-key` / the helper returns the right credential per mode

The host store tags each secret with its `kind` (§5). `print-key` reads the tag
and emits the **wire-ready header value** for the proxy to inject:

| stored kind | `print-key` stdout      | injected into header |
| ----------- | ----------------------- | -------------------- |
| `api-key`   | `sk-ant-api03-…` (bare) | `x-api-key`          |
| `oauth`     | `Bearer sk-ant-oat01-…` | `authorization`      |

`print-key` adds the `Bearer ` scheme for `oauth` so the proxy's `set_header`
stays a literal value-replace (§3). On no/locked/denied credential it still exits
non-zero with **no stdout**, so the proxy fails closed (`docs/agent-sandbox.md`
§3 step 5) — identical for both kinds.

The runner, at launch, reads the stored `kind` (`readAgentKey()` now returns
`{ kind, value }`), selects `adapter.authModes.find(m => m.kind === kind)`, and
from that one mode derives the cred-rule header, the in-guest env var, and the
placeholder (§3). If the stored kind isn't in the adapter's `authModes`, the
launch errors actionably (e.g. an api-key stored for an OAuth-only agent).

## 3. L2 — broker Bearer contract

**Build contract (one line):** the `api.anthropic.com` cred rule gains an
**`Authorization: Bearer` variant** — in OAuth mode the runner writes the rule
with `header=authorization`, sets the single in-guest env
`CLAUDE_CODE_OAUTH_TOKEN=<inert placeholder>`, and `print-key` emits
`Bearer <token>`; **fail-closed, MITM-scope, and the exact-IP peer-pin all hold
unchanged** because every enforcement path is header-agnostic.

### What the runner does in OAuth mode

`configureBroker` already writes the rule via `appliance-vm creds add <host>
--header <h> --inject --helper <print-key>` and turns MITM on. For OAuth mode
the **only** differences vs the api-key mode are values, not code paths:

- **Cred rule:** `{ host: 'api.anthropic.com', inject: true, capture: false,
header: 'authorization', helper: '<abs> agent print-key' }`. Note
  `authorization` is already `creds.rs`'s **default** header
  (`default_header()`), and `creds add --header` already accepts it
  (`appliance-vm.ts:676`, `main.rs:776`) — no new flag, no schema change.
- **In-guest env:** set **only** `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-appliance-proxy`
  (NOT `ANTHROPIC_API_KEY` — precedence, §1). `claude` then emits
  `Authorization: Bearer sk-ant-oat01-appliance-proxy`.
- **Injection:** `print-key` resolves `Bearer <real-oat-token>` host-side; the
  proxy's `set_header` (`creds.rs:296`) **replaces** the `authorization` header
  value on the **outbound copy only**. The real token crosses the host↔guest
  boundary **zero times**; the in-guest placeholder is inert.

The scheme lives in `print-key`'s output (mirroring the existing
`helper_overrides_stored_secret` convention where the helper emits
`'Bearer from-helper'`, `creds.rs:400`), so **no `creds.rs`/`mitm.rs` change is
needed** for the Bearer value — `set_header` already writes whatever
`header: value` pair it's handed.

### Confirmation: fail-closed / MITM-scope / peer-pin all still hold

The Bearer path rides the **same** enforcement code, which is **header- and
scheme-agnostic** end to end:

- **Fail-closed (502, token unconfigured).** `mitm::intercept` resolves
  `creds::resolve_injection` **before dialing upstream** (`mitm.rs:245`).
  `resolve_injection` matches on `first_matching(inject)` by **host**, not
  header (`creds.rs:234`,`:99`); when the helper yields nothing it returns
  `Injection::RuleButUnresolved` and `intercept` returns
  `write_cred_unconfigured` (`mitm.rs:251`,`:330`) — a `502 — … run \`appliance
  agent login\`` with **no upstream dialed**. The in-guest placeholder
  (api-key or oauth) leaves the host **zero times**. ✅ Holds identically; the
  502 path never inspects the header.
- **MITM scope (`api.anthropic.com` only).** `should_intercept` gates on
  `crate::creds::has_cred_rule(name, host)` (`egress.rs:423`), which matches by
  **host** (`creds.rs:209`). Adding the Bearer variant is still **one rule for
  the same host**, so the decrypt scope is unchanged — every other allowed
  HTTPS host stays a blind, streaming-preserving tunnel. ✅ Holds.
- **Exact-IP peer-pin.** `peer_allowed` pins the proxy to this VM's exact
  leased guest IP once known (`egress.rs:386`,`:393`), and `should_intercept`
  refuses to decrypt until the lease is known
  (`guest_ip_v4(name).is_some()`, `egress.rs:423`). Neither looks at the
  credential or its header. ✅ Holds — a co-resident sibling VM still cannot
  drive this VM's proxy to spend the brokered token, and there is no pre-lease
  injection window.
- **capture:false.** The OAuth rule is `capture:false` exactly like the api-key
  rule, so the in-guest placeholder Bearer token is **never** lifted into
  `egress-secrets.json` (`creds.rs:194` short-circuits without a capture rule).
  ✅ Holds.

**Net:** L2 is a **values-only** change on the host/runner side
(`utils/agent.ts` selects header/env/placeholder from the mode) plus a
kind-aware `print-key`. The Rust broker (`egress.rs`/`creds.rs`/`mitm.rs`) is
**unchanged** — the Bearer variant is the broker doing exactly what it already
does, on a different header value.

## 4. L3 — desktop contract (subsumes the deferred A5b)

**Build contract (one line):** a **"Sign in with Claude"** affordance (plus
**API-key entry**) on the desktop runs the **same host-side flow** via a Tauri
command — OAuth surfaces the `setup-token` URL and captures the token; the
credential is stored **host-side** (Keychain), **never sent to the VM** — closing
the deferred **A5b** ("desktop Store-Anthropic-key login affordance").

- A new Tauri command (e.g. `microvm_agent_login`) mirroring the existing
  `microvm_agent_start` sidecar pattern (`desktop/src-tauri/src/lib.rs:3708` —
  shells the bundled `appliance` CLI):
  - **API key:** the user pastes the key in the launcher; the command pipes it
    to `appliance agent login` over **stdin** (never argv), storing it
    `kind:'api-key'`.
  - **Sign in with Claude:** the command runs the host OAuth login
    (`appliance agent login --oauth`, which invokes `claude setup-token`
    host-side). It **streams the printed URL back to the UI** as a clickable /
    "open in browser" affordance and shows a spinner until `setup-token`
    returns the token, then stores it `kind:'oauth'`. (Per the link-safety
    posture, the URL opens in the user's own browser — the desktop surfaces it,
    it does not embed an OAuth webview.)
- The credential is written by the **same** `writeAgentKey` host store (§5);
  **nothing real is ever sent to the VM** — the desktop only triggers the host
  store + (later) the broker, exactly as the CLI does.
- The agent launcher (`pages/local-runtime`, A5) gains the login affordance and
  a "signed in as: API key / Claude subscription" indicator sourced from the
  stored `kind`. The existing keyless guard (CLI `start` → "No Anthropic key
  configured") now points users at this affordance.

## 5. Cred storage + placeholders

**One host store, tagged by kind.** The Anthropic credential lives host-side
**only** — macOS Keychain `sh.appliance.agent` (account `anthropic`), or a
`0600` file under `~/.appliance/agent/` off-macOS (today's `utils/agent.ts`
store). The stored secret becomes a small **JSON envelope** so the kind travels
with the value atomically in one item:

```json
{ "kind": "oauth", "value": "sk-ant-oat01-…" }
```

- `writeAgentKey(value, kind)` serializes the envelope; `readAgentKey()` returns
  `{ kind, value }`. **Back-compat:** a stored **bare (non-JSON) string** is read
  as `{ kind: 'api-key', value }`, so existing logins keep working without a
  migration step.
- The same Keychain/0600 protections apply to the OAuth token as to the API key
  — it is a long-lived opaque secret and is handled identically (host-only,
  never logged, never in any per-VM file, never in the VM).
- **Placeholders (inert, per mode), never real, only ever in the VM env:**

  | mode    | in-guest env var          | inert placeholder              |
  | ------- | ------------------------- | ------------------------------ |
  | api-key | `ANTHROPIC_API_KEY`       | `sk-ant-appliance-proxy`       |
  | oauth   | `CLAUDE_CODE_OAUTH_TOKEN` | `sk-ant-oat01-appliance-proxy` |

  The proxy overwrites the placeholder's header value with the real
  credential before the request leaves the host. A captured placeholder is
  worthless.

## 6. Security — for Sasha

**What changes vs the A0/A2 design: one thing.** A **second auth mode** — a
`header=authorization`, `Bearer`-scheme variant of the _same_ `api.anthropic.com`
cred rule, fed by a _long-lived OAuth token_ instead of an API key. **Everything
else is identical:** same egress proxy, same `creds.rs`/`mitm.rs`/`egress.rs`,
same single rule per host, same fail-closed, same MITM scope, same exact-IP
peer-pin, same `capture:false`. No new Rust, no new network listener, no new
trust boundary.

**What holds (unchanged guarantees).**

- **The credential never enters the VM** — Bearer path included. The OAuth
  token lives in the host Keychain, is resolved host-side by `print-key`
  (`Bearer <token>`), and is written onto the request **only** at the proxy on
  the outbound copy (`mitm.rs:267`, `creds.rs:296`). The VM holds at most an
  inert `sk-ant-oat01-appliance-proxy` placeholder. §3 walks each enforcement
  path (fail-closed / MITM-scope / peer-pin / capture:false) and shows it is
  header-agnostic, so the new mode inherits every guarantee.
- **Host token storage.** Keychain `sh.appliance.agent` on macOS; `0600` file
  off-macOS — same posture as the API key. The token is never logged (proxy
  logs the request **line** only, never headers) and never written to any
  per-VM file (`capture:false` → not in `egress-secrets.json`).
- **Fail-closed on the Bearer path.** If the token is unconfigured / Keychain
  locked / `setup-token` never run, `print-key` exits non-zero → the proxy
  returns `502` and dials no upstream → the placeholder Bearer never crosses
  the boundary (§3).

**What does NOT change (the caveats from `docs/agent-sandbox.md` §9 still
stand).** The **microVM is the only real isolation boundary**; egress is
cooperative, not enforced; a jailbroken guest can still drive the proxy to spend
the user's subscription **but cannot read the token** (it's brokered host-side).
Nothing here tightens or loosens that.

**The ToS constraint is a security/compliance boundary, not just a doc note.**
We broker the subscription token **only** onto Claude Code's own direct calls
(§0). We must never build a listener that accepts arbitrary model requests and
forwards them under the token — that would be reselling the subscription API and
is explicitly out of bounds. The header-injection design _cannot_ become that by
accident (it only rewrites a header on the agent's own egress), and L1–L3 must
not add an API-gateway surface.

## 7. Open questions / verify items (for Eliot / Sasha)

Empirical checks L1–L3 must confirm (analogous to the A0 STEP-0 placeholder
confirmation, which validated the api-key placeholder is accepted without local
pre-validation):

1. **`setup-token` stdout/stderr split.** Confirm exactly where `claude
setup-token` prints the URL vs the token, so the L1 capture (grep stdout for
   `sk-ant-oat01-` while inheriting the TTY for the URL) is robust. If
   `setup-token` is fully interactive with no clean stdout token line, L1 may
   need to parse the terminal output or prompt the user to paste the token —
   resolve before L1 ships. **Highest-leverage unknown here.**
2. **OAuth placeholder accepted without local pre-validation.** Confirm `claude`
   starts and emits `Authorization: Bearer sk-ant-oat01-appliance-proxy` when
   `CLAUDE_CODE_OAUTH_TOKEN` is the inert placeholder (the analogue of the
   verified api-key placeholder). If it pre-validates the token shape, adjust
   the placeholder to a shape it accepts.
3. **Precedence in practice.** Confirm that with **only**
   `CLAUDE_CODE_OAUTH_TOKEN` set in-guest (no `ANTHROPIC_API_KEY`), `claude`
   actually emits the Bearer (not falling through to interactive `/login`), so
   the broker overwrites a real header. (Design sets exactly one env to make
   this deterministic.)
4. **Host `claude` dependency for OAuth login.** `claude setup-token` needs
   `claude` on the **host**. Decide the precondition UX: detect + actionable
   error ("install Claude Code on this Mac to sign in"), or offer to install it
   host-side. (API-key mode has no host `claude` dependency.)
5. **Keychain envelope migration.** Confirm the back-compat read (bare string →
   `kind:'api-key'`) is sufficient, or whether to actively rewrite existing
   items to the JSON envelope on next `login`.

Non-blocking / owner forks: whether to keep `api-key` as the default offered
mode or lead with "Sign in with Claude"; whether the desktop indicator should
show token expiry (one year out) as a re-login nudge.

---

### Build-contract summary

| Level | Owner surface                             | One-line contract                                                                                                                                                  |
| ----- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1    | `appliance agent login` / `print-key`     | login is a mode picker (API key OR Sign in with Claude → host `claude setup-token`); store the credential tagged by kind; `print-key` emits the right wire value.  |
| L2    | runner + broker (`utils/agent.ts`)        | OAuth mode = cred rule `header=authorization` + in-guest `CLAUDE_CODE_OAUTH_TOKEN=<placeholder>` + `print-key` emits `Bearer <token>`; fail-closed/scope/pin hold. |
| L3    | desktop (`microvm_agent_login` Tauri cmd) | "Sign in with Claude" (surface the URL) or API-key entry runs the same host flow; cred stored host-side, never sent to the VM (closes A5b).                        |

_Suggested commit subject:_ `docs(agent-login): interactive OAuth login +
agent-agnostic auth-mode design`
