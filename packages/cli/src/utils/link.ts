import * as fs from 'node:fs';
import * as path from 'node:path';

// Per-project "link" record stored at .appliance/link.json in the
// project's working directory. Records which project + environment
// (and which API server / profile) commands like deploy / status /
// destroy / open should target when invoked with no args.
//
// The link is opportunistic — it's written by the first successful
// `setup` or `deploy` and read by subsequent invocations. Positional
// args still override the link, so existing scripts keep working.
//
// Reading walks up from cwd to support running commands from any
// subdirectory of the project.

const LINK_DIR = '.appliance';
const LINK_FILE = 'link.json';

/**
 * One service inside a sandbox project. For the Dockerfile slice this
 * is always a single entry; compose (a follow-up) models N services.
 * Shaped to be 1:1 promotable to a cloud Environment's per-service
 * builds (docs/up.md §5).
 */
export interface SandboxService {
  /** DNS-safe workload name (= project name for a single Dockerfile;
   *  the compose service name for each compose service). */
  name: string;
  /** Container port the workload listens on (from EXPOSE / --port, or
   *  the container side of a compose `ports:` mapping). Omitted for a
   *  compose service that publishes no port. */
  port?: number;
  /** Whether the port is published to the host. */
  exposed: boolean;
  /** Host port the container port is published to, when exposed. */
  hostPort?: number;
  /** Compose `depends_on` service names, best-effort parsed (item 7). */
  dependsOn?: string[];
}

/**
 * `appliance up` state, persisted additively alongside the api-server
 * link fields (docs/up.md §5). Present only for folders driven by the
 * in-guest Docker engine; absent for plain `deploy`-linked projects.
 */
export interface SandboxLink {
  /** Detected project type. `dockerfile`, `compose`, and `devcontainer`
   *  are implemented. */
  type: 'dockerfile' | 'compose' | 'devcontainer';
  /** The shared sandbox VM this project runs in. */
  vm: string;
  /** Deterministic project id (cwd basename, normalized to a label). */
  project: string;
  /** Per-service ports + exposed flags. */
  services: SandboxService[];
  /** Compose file (relative to cwd) `up` was invoked with, so `down` /
   *  `logs` can reconstruct the `-f` argument. Compose links only. */
  composeFile?: string;
  /** Container id the `@devcontainers/cli` brought up, used by `down` /
   *  `logs` / `status` / `shell`. Devcontainer links only. */
  containerId?: string;
  /** Guest workspace folder the devcontainer was started against
   *  (the VirtioFS share, e.g. `/persist/workspace`). Devcontainer
   *  links only — `shell` / `exec` re-pass it as `--workspace-folder`. */
  workspace?: string;
}

export interface ProjectLink {
  /** Project name on the api-server. */
  projectName?: string;
  /** Default environment to target. */
  environmentName?: string;
  /**
   * API server URL the link was created against. Stored for parity
   * with the credentials profile; mismatch between this and the
   * active profile is a yellow warning, not a hard error.
   */
  apiUrl?: string;
  /**
   * Credentials profile the link was created against. Same parity
   * rationale as apiUrl above.
   */
  profile?: string;
  /** ISO timestamp recording when the link was last written. */
  linkedAt?: string;
  /**
   * `appliance up` sandbox state. Additive — does not disturb the
   * api-server `projectName`/`environmentName` fields above.
   */
  sandbox?: SandboxLink;
}

export interface LinkLocation {
  /** Directory containing the .appliance/link.json file. */
  rootDir: string;
  /** Absolute path to the link.json file. */
  filePath: string;
}

/**
 * Walk up from cwd looking for a .appliance/link.json. Returns the
 * containing directory and absolute file path, or null if none found
 * before hitting the filesystem root.
 */
export function findLinkLocation(startDir: string = process.cwd()): LinkLocation | null {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, LINK_DIR, LINK_FILE);
    if (fs.existsSync(candidate)) {
      return { rootDir: dir, filePath: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Parse the raw link file (any valid object), or null if none exists /
 * it's malformed. Lower-level than `readLink` — it does not require the
 * api-server fields, so a sandbox-only link is returned intact.
 */
export function readRawLink(startDir?: string): ProjectLink | null {
  const loc = findLinkLocation(startDir);
  if (!loc) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(loc.filePath, 'utf-8'));
    if (parsed && typeof parsed === 'object') return parsed as ProjectLink;
    return null;
  } catch {
    // Corrupt file shouldn't brick the CLI — treat as no link.
    return null;
  }
}

/**
 * Parsed api-server link or null if no link exists / the file lacks the
 * api-server project + environment fields (e.g. a sandbox-only link).
 */
export function readLink(startDir?: string): ProjectLink | null {
  const parsed = readRawLink(startDir);
  if (parsed && typeof parsed.projectName === 'string' && typeof parsed.environmentName === 'string') {
    return parsed;
  }
  return null;
}

/** The sandbox block of the cwd link, or null when there isn't one. */
export function readSandboxLink(startDir?: string): SandboxLink | null {
  const parsed = readRawLink(startDir);
  return parsed?.sandbox ?? null;
}

/**
 * Write the link file at `rootDir/.appliance/link.json`. Defaults to
 * cwd. Creates the directory if needed; writes are atomic from the
 * caller's perspective (single fs.writeFileSync).
 */
export function writeLink(link: ProjectLink, rootDir: string = process.cwd()): string {
  const dir = path.join(path.resolve(rootDir), LINK_DIR);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, LINK_FILE);
  const payload: ProjectLink = { ...link, linkedAt: link.linkedAt ?? new Date().toISOString() };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n');
  return filePath;
}

/**
 * Merge a `sandbox` block into the cwd link additively, preserving any
 * existing api-server `projectName`/`environmentName` fields. Pass null
 * to remove the sandbox block (e.g. on `down`). Writes (and creates)
 * `.appliance/link.json` in `rootDir`.
 */
export function writeSandboxLink(sandbox: SandboxLink | null, rootDir: string = process.cwd()): string {
  const existing = readRawLink(rootDir) ?? {};
  const next: ProjectLink = { ...existing };
  if (sandbox) next.sandbox = sandbox;
  else delete next.sandbox;
  // Touch linkedAt so the timestamp reflects this write.
  return writeLink({ ...next, linkedAt: new Date().toISOString() }, rootDir);
}

/**
 * Remove the link file. Returns true if a link existed and was
 * removed, false if there was nothing to remove.
 */
export function clearLink(startDir?: string): boolean {
  const loc = findLinkLocation(startDir);
  if (!loc) return false;
  try {
    fs.unlinkSync(loc.filePath);
    // Remove the .appliance directory if empty so we don't leave
    // litter behind.
    try {
      fs.rmdirSync(path.dirname(loc.filePath));
    } catch {
      // Non-empty or already gone — ignore.
    }
    return true;
  } catch {
    return false;
  }
}
