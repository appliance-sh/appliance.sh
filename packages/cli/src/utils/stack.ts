import * as fs from 'node:fs';
import * as path from 'node:path';
import { stackInput, type StackInput } from '@appliance.sh/sdk';

// Loading + resolution for `appliance.stack.json`, the collection
// manifest behind `appliance stack …`. The schema itself lives in the
// SDK (models/stack.ts); this module owns the filesystem side: finding
// the file, validating it, and resolving member entries to absolute
// directories + concrete environments.

export const STACK_FILENAME = 'appliance.stack.json';

export const DEFAULT_STACK_ENVIRONMENT = 'dev';

export interface LoadedStack {
  stack: StackInput;
  /** Absolute path of the stack file. */
  filePath: string;
  /** Directory member `dir` entries resolve against. */
  rootDir: string;
}

export function loadStack(explicitPath?: string, cwd: string = process.cwd()): LoadedStack {
  const filePath = explicitPath ? path.resolve(cwd, explicitPath) : path.join(cwd, STACK_FILENAME);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      explicitPath
        ? `Stack file not found: ${filePath}`
        : `No ${STACK_FILENAME} in this directory. Scaffold one with \`appliance stack init\`, or pass --file <path>.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = stackInput.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Invalid stack file ${filePath}: ${issues}`);
  }

  return { stack: parsed.data, filePath, rootDir: path.dirname(filePath) };
}

export interface ResolvedStackApp {
  /** Absolute member directory. */
  dir: string;
  /** Directory as written in the stack file (for display). */
  relDir: string;
  /** Explicit project name, when the entry pins one. Entries without
   *  one fall back to their manifest `name` at execution time. */
  project?: string;
  /** Environment after applying the precedence cascade. */
  environment: string;
  /** Deploy-time env declared on the stack entry, un-interpolated. */
  env?: Record<string, string>;
}

/**
 * Resolve member entries to absolute directories and concrete
 * environments. Environment precedence per app: the CLI argument >
 * `app.environment` > `stack.environment` > 'dev'. The CLI argument
 * deliberately beats per-app pins so `appliance stack deploy <fresh>`
 * clones the whole collection into a new environment without edits.
 */
export function resolveStackApps(loaded: LoadedStack, environmentArg?: string): ResolvedStackApp[] {
  const resolved: ResolvedStackApp[] = loaded.stack.apps.map((app) => ({
    dir: path.resolve(loaded.rootDir, app.dir),
    relDir: app.dir,
    project: app.project,
    environment: environmentArg ?? app.environment ?? loaded.stack.environment ?? DEFAULT_STACK_ENVIRONMENT,
    env: app.env,
  }));

  for (const app of resolved) {
    if (!fs.existsSync(app.dir) || !fs.statSync(app.dir).isDirectory()) {
      throw new Error(`Stack app directory not found: ${app.dir} (entry "${app.relDir}" in ${loaded.filePath})`);
    }
  }

  // Two entries resolving to the same project + environment would
  // silently stomp each other's deploys — refuse early. Entries without
  // an explicit project are keyed by directory instead (their manifest
  // name isn't known yet at resolution time).
  const seen = new Map<string, string>();
  for (const app of resolved) {
    const key = app.project ? `${app.project}/${app.environment}` : `${app.dir}#${app.environment}`;
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Error(
        `Stack entries "${prior}" and "${app.relDir}" resolve to the same target — ` +
          `give one a distinct \`project\` or \`environment\`.`
      );
    }
    seen.set(key, app.relDir);
  }

  return resolved;
}

/** What env interpolation needs to know about a member. Gathered once
 *  per `stack deploy` from the stack entry + the member's manifest. */
export interface StackMemberInfo {
  /** Entry `project` pin, else the manifest `name`; undefined when the
   *  member has neither (only an error if something references it). */
  projectName?: string;
  /** Environment after the resolution cascade. */
  environment: string;
  /** Manifest `port`, defaulting to 8080 like the container runtimes. */
  port: number;
}

// `{{service:dir}}` / `{{url:dir}}` — the two things a member can know
// about a sibling. Keyed by the sibling's `dir` exactly as written in
// the stack file, the one name that's always local and unambiguous.
const ENV_PLACEHOLDER = /\{\{\s*(service|url)\s*:\s*([^{}\s]+)\s*\}\}/g;

/**
 * Interpolate a member's stack-declared env. Two placeholder forms:
 *
 * - `{{service:dir}}` → `http://<project>-<environment>:<port>`, the
 *   sibling's in-network address. The docker base serves it as a
 *   network alias and the Kubernetes base as the Service name, so the
 *   value is identical on both — and deterministic, so it never
 *   depends on deploy order.
 * - `{{url:dir}}` → the sibling's host-facing URL as reported by its
 *   deploy this run (`urls`), for values that end up in a browser.
 *   Members deploy in file order, so the sibling must come first.
 *
 * Throws with the offending key and the known dirs on a bad reference —
 * a wiring typo should fail the member's deploy, not ship half-wired.
 */
export function resolveStackAppEnv(
  app: ResolvedStackApp,
  members: Map<string, StackMemberInfo>,
  urls: Map<string, string>
): Record<string, string> | undefined {
  if (!app.env || Object.keys(app.env).length === 0) return undefined;

  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(app.env)) {
    resolved[key] = value.replace(ENV_PLACEHOLDER, (_whole, kind: string, ref: string) => {
      const member = members.get(ref);
      if (!member) {
        throw new Error(
          `"${app.relDir}" env ${key}: unknown stack member "${ref}" — members are referenced by dir (${[...members.keys()].join(', ')}).`
        );
      }
      if (kind === 'service') {
        if (!member.projectName) {
          throw new Error(
            `"${app.relDir}" env ${key}: cannot resolve {{service:${ref}}} — "${ref}" has no manifest \`name\`; set "project" on its stack entry.`
          );
        }
        return `http://${member.projectName}-${member.environment}:${member.port}`;
      }
      const url = urls.get(ref);
      if (!url) {
        throw new Error(
          `"${app.relDir}" env ${key}: {{url:${ref}}} needs "${ref}" deployed first — move it earlier in \`apps\`, or use {{service:${ref}}} for service-to-service calls.`
        );
      }
      return url;
    });
  }
  return resolved;
}
