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

// Build-time-only manifest fields. These describe *how the appliance
// is packaged* (artifact format, port, scripts) and end up persisted
// in the zip's `appliance.json` — environment-invariant by design.
// Per-environment runtime config (env vars, memory, timeout, storage)
// lives separately in `applianceRuntimeConfig` and travels through
// the deploy call, never the build artifact.
export const applianceTypeBase = z.object({
  manifest: z.literal('v1'),
  name: dnsName,
  version: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
});

// Runtime configuration applied to a deployed appliance instance.
// Authored alongside the build manifest in a programmatic appliance
// file (a TS function can return both shapes), but never persisted
// into the build artifact. The CLI evaluates the manifest at deploy
// time and forwards these fields on the deploy payload, where
// per-environment overrides can also be merged.
export const applianceRuntimeConfig = z.object({
  // Lambda memory in MB.
  memory: z.number().int().min(128).max(10240).optional(),
  // Lambda timeout in seconds.
  timeout: z.number().int().min(1).max(900).optional(),
  // Ephemeral /tmp storage in MB. Cloud-agnostic at the schema level;
  // the backend maps it to the target's equivalent (AWS: Lambda
  // ephemeralStorage).
  storage: z.number().int().min(512).max(10240).optional(),
  // Runtime environment variables. Merged with deploy-time
  // overrides; the deploy call wins on conflict.
  env: z.record(z.string(), z.string()).optional(),
});

export type ApplianceRuntimeConfig = z.infer<typeof applianceRuntimeConfig>;

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

// What a programmatic manifest function is allowed to return: build
// fields + runtime config inline. The CLI extracts each half via the
// matching schema (applianceInput strips runtime, applianceRuntimeConfig
// strips build). Static appliance.json files validate against
// applianceInput alone and don't carry runtime config.
export const applianceFullInput = z.intersection(applianceInput, applianceRuntimeConfig);
export type ApplianceFullInput = z.infer<typeof applianceFullInput>;
export type ApplianceFull = z.output<typeof applianceFullInput>;

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
