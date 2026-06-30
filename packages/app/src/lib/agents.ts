import { Github, Sparkles, SquareTerminal, type LucideIcon } from 'lucide-react';

// UI-side mirror of the agent adapter registry in
// `packages/cli/src/utils/agent.ts` (claude-code / copilot / codex). The app
// bundle can't import the CLI registry directly — that module pulls in
// node:fs/os/child_process — so we mirror the UI-relevant fields here: the
// `--type` registry key, a human label + icon, the per-agent host cred-store
// `provider`, and which credential UX the login panel renders. Keep the
// `type`/`provider` pairs in sync with the CLI adapters (docs/multi-agent-adapters.md §1/§4).

/** The login UX a given agent needs (docs/multi-agent-adapters.md §4):
 *   • `claude`     — API-key OR "Sign in with Claude" (setup-token OAuth).
 *   • `github-pat` — a fine-grained GitHub PAT scoped to `Copilot Requests`.
 *   • `openai-key` — an OpenAI API key (soft `sk-` shape warning). */
export type AgentLoginStyle = 'claude' | 'github-pat' | 'openai-key';

export interface AgentAdapterUi {
  /** The `--type` registry key passed to `agent start` / `agent login`. */
  type: string;
  /** Human label for the picker, tabs, and login panel. */
  label: string;
  /** Short tagline shown in the picker. */
  blurb: string;
  /** The per-agent host cred-store key — mirrors the CLI adapter's `provider`
   *  (`anthropic` / `github-copilot` / `openai`), so three agents' credentials
   *  never collide (docs/multi-agent-adapters.md §4). */
  provider: string;
  /** The CLI binary the agent runs in-guest (mirrors the CLI adapter's
   *  `install.bin`) — shown in the launcher hint. */
  bin: string;
  Icon: LucideIcon;
  /** Which credential UX the login panel renders for this agent. */
  login: AgentLoginStyle;
}

/** The registered agent adapters, in picker order. The launcher reads this so a
 *  new agent shows up by adding an entry here (mirroring a new CLI adapter) —
 *  never hard-coded at the call site. */
export const AGENT_ADAPTERS: AgentAdapterUi[] = [
  {
    type: 'claude-code',
    label: 'Claude Code',
    blurb: 'Anthropic · API key or Claude subscription',
    provider: 'anthropic',
    bin: 'claude',
    Icon: Sparkles,
    login: 'claude',
  },
  {
    type: 'copilot',
    label: 'GitHub Copilot',
    blurb: 'GitHub · fine-grained PAT (Copilot Requests)',
    provider: 'github-copilot',
    bin: 'copilot',
    Icon: Github,
    login: 'github-pat',
  },
  {
    type: 'codex',
    label: 'OpenAI Codex',
    blurb: 'OpenAI · API key',
    provider: 'openai',
    bin: 'codex',
    Icon: SquareTerminal,
    login: 'openai-key',
  },
];

/** The default agent type (matches the CLI's `--type` default). */
export const DEFAULT_AGENT_TYPE = 'claude-code';

/** Resolve an agent type to its UI adapter, falling back to the default so an
 *  unknown/rehydrated type still renders rather than throwing. */
export function agentAdapter(type: string): AgentAdapterUi {
  return AGENT_ADAPTERS.find((a) => a.type === type) ?? AGENT_ADAPTERS[0];
}

/** Human label for an agent type (the registry label, else the raw key). */
export function agentLabel(type: string): string {
  return AGENT_ADAPTERS.find((a) => a.type === type)?.label ?? type;
}

// ---- credential validation (mirrors the CLI guards) ---------------------

/** The fine-grained GitHub PAT prefix Copilot's host-keyed injection is bound
 *  to. Mirrors `GITHUB_FINE_GRAINED_PAT_PREFIX` in the CLI: the login layer
 *  accepts ONLY `github_pat_` tokens and REJECTS classic `ghp_` PATs — the
 *  fine-grained PAT's narrow `Copilot Requests` scope is the entire security
 *  bound on host-keyed PAT injection (docs/multi-agent-adapters.md §4/§7). */
export const GITHUB_FINE_GRAINED_PAT_PREFIX = 'github_pat_';
const GITHUB_CLASSIC_PAT_PREFIX = 'ghp_';

/** Where the user mints a fine-grained PAT — linked from the Copilot login UX. */
export const GITHUB_FINE_GRAINED_PAT_SETTINGS_URL = 'https://github.com/settings/personal-access-tokens/new';

export type CopilotPatValidation = { ok: true; value: string } | { ok: false; reason: 'empty' | 'classic' | 'shape' };

/** Validate a Copilot login credential — mirrors the CLI's `validateCopilotPat`
 *  (the HARD pre-ship guard). REJECTS classic `ghp_` PATs and anything that is
 *  not a fine-grained `github_pat_` token. The fine-grained PAT scoped to
 *  `Copilot Requests` only is the security bound on host-keyed injection. */
export function validateCopilotPat(raw: string): CopilotPatValidation {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.startsWith(GITHUB_CLASSIC_PAT_PREFIX)) return { ok: false, reason: 'classic' };
  if (!value.startsWith(GITHUB_FINE_GRAINED_PAT_PREFIX)) return { ok: false, reason: 'shape' };
  return { ok: true, value };
}

/** Soft shape check for an OpenAI API key (`sk-…`) — mirrors the CLI's
 *  `looksLikeOpenAiKey`. Codex login WARNS but still stores on a mismatch
 *  (no hard format guard, like Claude's api-key path). */
export function looksLikeOpenAiKey(raw: string): boolean {
  return raw.trim().startsWith('sk-');
}
