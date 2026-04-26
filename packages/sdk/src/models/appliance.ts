import { z } from 'zod';
import { dnsName, portInput } from '../common';

export enum ApplianceType {
  container = 'container',
  framework = 'framework',
  desktop = 'desktop',
  other = 'other',
}

export enum AppliancePlatform {
  LinuxAmd64 = 'linux/amd64',
  LinuxArm64 = 'linux/arm64',
}

// Well-known desktop targets. Suggestion list for wizards/autocomplete
// only — the schema accepts any string so PWAs (no native target),
// Rust target triples, or future variants all validate.
export const KnownDesktopPlatforms = [
  'macos-arm64',
  'macos-x64',
  'windows-x64',
  'windows-arm64',
  'linux-x64',
  'linux-arm64',
] as const;
export type KnownDesktopPlatform = (typeof KnownDesktopPlatforms)[number];

// Suggested builder identifiers for the three desktop packaging
// variants: PWA (implemented first), Tauri (planned), Electron
// (future). `builder` on the manifest stays a free string while
// each variant's shape is still being defined — the suggestions
// are only for wizards/autocomplete.
export const KnownDesktopBuilders = ['pwa', 'tauri', 'electron'] as const;
export type KnownDesktopBuilder = (typeof KnownDesktopBuilders)[number];

export enum ApplianceFramework {
  Auto = 'auto',
  Python = 'python',
  Node = 'node',
  Other = 'other',
}

export const applianceTypeSchema = z.enum(ApplianceType);

export const applianceTypeBase = z.object({
  manifest: z.literal('v1'),
  name: dnsName,
  version: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  memory: z.number().int().min(128).max(10240).optional(),
  timeout: z.number().int().min(1).max(900).optional(),
  // Ephemeral scratch storage in MB. Cloud-agnostic at the manifest level;
  // the backend maps it to the target's equivalent (AWS: Lambda
  // ephemeralStorage, i.e. /tmp size).
  storage: z.number().int().min(512).max(10240).optional(),
  // Static environment variables baked into the build. Merged with
  // runtime env passed at deploy time (runtime wins on conflict).
  // Declared at the manifest level so a TS manifest can compute them
  // from build-time context (APPLIANCE_MODE=server/worker, VERSION,
  // etc.) without round-tripping through the deploy call.
  env: z.record(z.string(), z.string()).optional(),
});

export const applianceTypeContainerInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.container),
  port: portInput,
  platform: z.nativeEnum(AppliancePlatform).optional().default(AppliancePlatform.LinuxAmd64),
});

export const applianceTypeFrameworkInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.framework),
  framework: z.string().optional().default('auto'),
  platform: z.nativeEnum(AppliancePlatform).optional().default(AppliancePlatform.LinuxAmd64),
  port: portInput.optional(),
  includes: z.array(z.string()).optional(),
  excludes: z.array(z.string()).optional(),
});

// Intentionally minimal while the desktop packaging story is in flux
// (PWA today, Tauri/Electron/etc. possibly later). `builder` and
// `platforms` are free-form so any shape validates; tighten when the
// concrete builders land.
export const applianceTypeDesktopInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.desktop),
  builder: z.string().optional(),
  platforms: z.array(z.string().min(1)).optional(),
  artifactDir: z.string().optional(),
  bundledResources: z.array(z.string()).optional(),
});

export const applianceTypeOtherInput = applianceTypeBase.extend({
  type: z.literal(applianceTypeSchema.enum.other),
});

export const applianceInput = z.discriminatedUnion('type', [
  applianceTypeContainerInput,
  applianceTypeFrameworkInput,
  applianceTypeDesktopInput,
  applianceTypeOtherInput,
]);

export type ApplianceInput = z.infer<typeof applianceInput>;
export type Appliance = z.output<typeof applianceInput>;

// Context passed to function-form default exports of programmatic
// (.ts/.js) manifests. Lets a single manifest module return
// different shapes depending on the CLI invocation — e.g. one file
// that emits a server config or a worker config based on `variant`,
// or that reads project/environment to produce per-target env vars.
//
// `variant` is populated at both build and deploy time. `project`
// and `environment` are populated only at deploy time (undefined
// during `appliance build`); the build artifact itself is meant to
// be environment-invariant — only env vars are re-rendered per
// deploy from the same artifact.
export interface ManifestContext {
  /** Directory the CLI was invoked from (process.cwd at load time). */
  cwd: string;
  /** Value passed via `--variant <name>`; undefined when the flag is absent. */
  variant?: string;
  /** Project name being deployed; undefined during `appliance build`. */
  project?: string;
  /** Environment name being deployed; undefined during `appliance build`. */
  environment?: string;
  /** Snapshot of process.env at load time. */
  env: Record<string, string | undefined>;
}
export type ApplianceContainer = z.output<typeof applianceTypeContainerInput>;
export type ApplianceFrameworkApp = z.output<typeof applianceTypeFrameworkInput>;
export type ApplianceDesktop = z.output<typeof applianceTypeDesktopInput>;
export type ApplianceOther = z.output<typeof applianceTypeOtherInput>;
