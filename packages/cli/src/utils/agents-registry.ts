import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_SANDBOX_VM, runVmCapture } from './sandbox.js';
import { readSandboxVm } from './link.js';

// Per-project agent registry (Phase 5, A4) — `.appliance/agents.json`,
// the sibling of `link.json` (utils/link.ts). It records the coding
// agents launched into a project's sandbox VM so `appliance agent
// list/stop/attach` (A3) and the desktop tab badge (A5) have a source of
// truth, and so liveness can be reconciled against the actual tmux
// sessions in the VM (docs/agent-sandbox.md §7).
//
// The file is project-local and additive: it commits/ignores with the
// repo as the owner chooses. Writes are atomic (temp + rename) and reads
// tolerate a missing or corrupt file — a broken registry never bricks the
// CLI.

const REGISTRY_DIR = '.appliance';
const REGISTRY_FILE = 'agents.json';

/** Lifecycle of a registry entry. `running` is set at launch; reconcile
 *  flips a `running` entry whose tmux session has vanished to `exited`.
 *  `done`/`error` are autonomous-result terminal states (A6 sets those). */
export type AgentStatus = 'running' | 'done' | 'error' | 'exited';

/** One agent in the registry. The spike shape (docs §7) is
 *  `{ id, type, task?, status, sessionId, launchedAt }`; `vm` + `mode`
 *  are additive — `vm` is required to reconcile liveness against the
 *  right VM's session list, `mode` distinguishes interactive vs
 *  autonomous for display. */
export interface AgentRecord {
  /** The host id — the `agent-` prefix stripped from `sessionId`. This is
   *  what the user passes to `appliance agent stop/attach <id>`. */
  id: string;
  /** Adapter key, e.g. `claude-code`. */
  type: string;
  /** Autonomous: the prompt. Interactive: an optional label. */
  task?: string;
  status: AgentStatus;
  /** The `agent-<uuid>` tmux session id (the `--session` arg + what
   *  `appliance-vm sessions list` reports). */
  sessionId: string;
  /** ISO timestamp the agent was launched at. */
  launchedAt: string;
  /** The VM the agent runs in — reconcile lists this VM's sessions. */
  vm?: string;
  /** How it was launched (display only). */
  mode?: 'interactive' | 'autonomous';
}

/** The on-disk file shape (docs §7 wraps the list in `{ agents }`). */
interface RegistryFileShape {
  agents: AgentRecord[];
}

// ---- id helpers --------------------------------------------------------

/** The host id for a session id (`agent-<uuid>` → `<uuid>`). */
export function agentIdFromSession(sessionId: string): string {
  return sessionId.replace(/^agent-/, '');
}

// ---- file resolution ---------------------------------------------------

/** The registry path for a project root (`<root>/.appliance/agents.json`). */
export function registryFileFor(rootDir: string): string {
  return path.join(path.resolve(rootDir), REGISTRY_DIR, REGISTRY_FILE);
}

/** Walk up from `startDir` to the first existing `.appliance/agents.json`,
 *  mirroring link.ts so the command works from any subdirectory of the
 *  project. Null when none exists before the filesystem root. */
export function findRegistryFile(startDir: string = process.cwd()): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, REGISTRY_DIR, REGISTRY_FILE);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The file a mutation reads + writes: an explicit project root when
 *  given (the `start` path, which writes alongside the mounted project),
 *  else the walked-up existing file, else cwd. */
function resolveRegistryFile(rootDir?: string): string {
  if (rootDir) return registryFileFor(rootDir);
  return findRegistryFile() ?? registryFileFor(process.cwd());
}

// ---- read / write ------------------------------------------------------

function isAgentRecord(v: unknown): v is AgentRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.type === 'string' &&
    typeof r.sessionId === 'string' &&
    typeof r.status === 'string' &&
    typeof r.launchedAt === 'string'
  );
}

/** Parse a specific registry file, tolerating a missing or corrupt file
 *  (returns []) and both the `{ agents: [...] }` wrapper and a bare
 *  `[...]` array. Non-conforming entries are dropped, not fatal. */
function readRegistryFile(file: string): AgentRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return []; // missing → empty
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const arr = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as RegistryFileShape).agents)
        ? (parsed as RegistryFileShape).agents
        : null;
    if (!arr) return [];
    return arr.filter(isAgentRecord);
  } catch {
    return []; // corrupt → empty (never brick the CLI)
  }
}

/** Read the registry by walking up from `startDir` (read-only consumers
 *  like `list`/`stop`/`attach` that run from anywhere in the project). */
export function readRegistry(startDir?: string): AgentRecord[] {
  const file = findRegistryFile(startDir);
  return file ? readRegistryFile(file) : [];
}

/** Atomic write: serialize to a sibling temp file then rename over the
 *  target, so a reader never sees a half-written registry (and a crash
 *  mid-write leaves the old file intact). */
function writeRegistryFile(file: string, agents: AgentRecord[]): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.agents.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`);
  const payload: RegistryFileShape = { agents };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

// ---- mutations ---------------------------------------------------------

/** Insert or update an agent, keyed by `id`/`sessionId`. Writes to the
 *  given project root (the `start` path passes the mounted project dir).
 *  Returns the stored record. */
export function upsertAgent(record: AgentRecord, rootDir?: string): AgentRecord {
  const file = resolveRegistryFile(rootDir);
  const agents = readRegistryFile(file);
  const idx = agents.findIndex((a) => a.id === record.id || a.sessionId === record.sessionId);
  if (idx >= 0) agents[idx] = { ...agents[idx], ...record };
  else agents.push(record);
  writeRegistryFile(file, agents);
  return record;
}

/** Remove an agent (by id / sessionId / unique prefix). Returns the
 *  removed record, or null when nothing matched. */
export function removeAgent(arg: string, rootDir?: string): AgentRecord | null {
  const file = resolveRegistryFile(rootDir);
  const agents = readRegistryFile(file);
  const match = findAgent(arg, agents);
  if (!match) return null;
  writeRegistryFile(
    file,
    agents.filter((a) => a !== match)
  );
  return match;
}

/** Set an agent's status (by id / sessionId / unique prefix). Returns the
 *  updated record, or null when nothing matched. */
export function updateAgentStatus(arg: string, status: AgentStatus, rootDir?: string): AgentRecord | null {
  const file = resolveRegistryFile(rootDir);
  const agents = readRegistryFile(file);
  const match = findAgent(arg, agents);
  if (!match) return null;
  match.status = status;
  writeRegistryFile(file, agents);
  return match;
}

/** Resolve a user-supplied handle to an agent. Accepts the bare host id,
 *  the full `agent-<id>` session id, or an unambiguous prefix of either —
 *  so `stop`/`attach` are forgiving about which form the user pasted. */
export function findAgent(arg: string, agents: AgentRecord[]): AgentRecord | null {
  const bare = arg.replace(/^agent-/, '');
  const exact = agents.find(
    (a) => a.id === bare || a.id === arg || a.sessionId === arg || a.sessionId === `agent-${bare}`
  );
  if (exact) return exact;
  const prefix = agents.filter((a) => a.id.startsWith(bare) || a.sessionId.startsWith(`agent-${bare}`));
  return prefix.length === 1 ? prefix[0] : null;
}

// ---- liveness reconciliation -------------------------------------------

/** The VM an entry runs in: its recorded `vm`, else the cwd project's
 *  linked sandbox VM, else the shared default. */
function vmForRecord(record: AgentRecord): string {
  return record.vm ?? readSandboxVm() ?? DEFAULT_SANDBOX_VM;
}

/** The set of live session ids in a VM (`appliance-vm sessions list <vm>`,
 *  whose JSON ids already have the `appliance-` prefix stripped to the
 *  `agent-<uuid>` session id). Returns null when the listing fails — VM
 *  down / unreachable — so the caller treats liveness as *unknown* rather
 *  than declaring every agent dead on a transient. */
export function listLiveSessionIds(vm: string): Set<string> | null {
  const r = runVmCapture(['sessions', 'list', vm]);
  if (r.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(parsed)) return new Set();
    const ids = new Set<string>();
    for (const e of parsed) {
      if (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') {
        ids.add((e as { id: string }).id);
      }
    }
    return ids;
  } catch {
    return null;
  }
}

/** Pure reconcile core (unit-tested): cross-check each agent's session id
 *  against its VM's live session set. A `running` entry whose session is
 *  gone becomes `exited`; terminal states (`done`/`error`/`exited`) are
 *  never resurrected. A VM with an unknown (null) live set leaves its
 *  agents untouched and reports liveness `null`. */
export function reconcileStatuses(
  agents: AgentRecord[],
  liveByVm: Map<string, Set<string> | null>,
  vmOf: (a: AgentRecord) => string
): { agents: AgentRecord[]; changed: boolean; live: Record<string, boolean | null> } {
  let changed = false;
  const live: Record<string, boolean | null> = {};
  const next = agents.map((a) => {
    const set = liveByVm.get(vmOf(a));
    if (set == null) {
      live[a.sessionId] = null; // VM unreachable → liveness unknown
      return a;
    }
    const isLive = set.has(a.sessionId);
    live[a.sessionId] = isLive;
    if (!isLive && a.status === 'running') {
      changed = true;
      return { ...a, status: 'exited' as AgentStatus };
    }
    return a;
  });
  return { agents: next, changed, live };
}

/** Read the registry, reconcile each agent's status against the live tmux
 *  sessions in its VM, persist any `running` → `exited` transitions, and
 *  return the reconciled view plus a per-session liveness map (true/false,
 *  or null when the VM was unreachable). Backs `appliance agent list`. */
export function reconcileRegistry(rootDir?: string): {
  agents: AgentRecord[];
  live: Record<string, boolean | null>;
} {
  const file = resolveRegistryFile(rootDir);
  const agents = readRegistryFile(file);
  const liveByVm = new Map<string, Set<string> | null>();
  for (const a of agents) {
    const vm = vmForRecord(a);
    if (!liveByVm.has(vm)) liveByVm.set(vm, listLiveSessionIds(vm));
  }
  const { agents: next, changed, live } = reconcileStatuses(agents, liveByVm, vmForRecord);
  if (changed) writeRegistryFile(file, next);
  return { agents: next, live };
}
