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

export interface ProjectLink {
  /** Project name on the api-server. */
  projectName: string;
  /** Default environment to target. */
  environmentName: string;
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

/** Parsed link or null if no link exists / file is malformed. */
export function readLink(startDir?: string): ProjectLink | null {
  const loc = findLinkLocation(startDir);
  if (!loc) return null;
  try {
    const raw = fs.readFileSync(loc.filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.projectName === 'string' &&
      typeof parsed.environmentName === 'string'
    ) {
      return parsed as ProjectLink;
    }
    return null;
  } catch {
    // Corrupt file shouldn't brick the CLI — treat as no link.
    return null;
  }
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
