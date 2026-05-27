// Shared types for the dependency-helper providers.
//
// A provider is a pluggable adapter for a single tool the local
// runtime depends on (docker, k3d, kubectl, …). Each provider knows
// how to *probe* the system for the tool, *describe* the platform-
// appropriate install path, and (optionally) *download* the tool
// into Appliance's managed bin directory.
//
// The orchestrator never assumes anything platform-specific — every
// branch lives inside the providers themselves so adding a new tool
// is one file, not a sprawl of switch statements.

export type Platform = 'darwin' | 'linux' | 'win32';
export type Arch = 'x64' | 'arm64';

/** Per-call context handed to a provider. */
export interface Context {
  /**
   * Directory the helper installs binaries into. Always under
   * `~/.appliance/bin` so it survives uninstalls of the CLI/desktop
   * cleanly and shows up consistently when PATH is augmented at
   * spawn time. Created by the orchestrator before `install` runs.
   */
  binDir: string;
  platform: Platform;
  arch: Arch;
  /** Streamed progress events the caller can render however they want. */
  onProgress?: (event: ProgressEvent) => void;
}

export type ProgressEvent =
  | { type: 'start'; tool: string; message: string }
  | { type: 'progress'; tool: string; message: string; percent?: number }
  | { type: 'done'; tool: string; message: string }
  | { type: 'error'; tool: string; message: string };

export interface CheckResult {
  /** True iff the tool was found and `--version` exited 0. */
  installed: boolean;
  /** Resolved version string, e.g. "v5.8.3". Best-effort. */
  version?: string;
  /** Absolute path the tool was resolved at (PATH lookup result). */
  path?: string;
  /**
   * stderr or io error captured when the version check failed. Lets
   * UIs distinguish "not installed" from "installed but broken".
   */
  error?: string;
}

export interface ManualInstall {
  /**
   * Human-readable, copy-pasteable shell command(s) for installing
   * the tool when auto-install isn't possible (typically because the
   * tool requires elevated privileges, kernel access, or a GUI).
   */
  instructions: string;
  /** Optional canonical install docs URL. */
  url?: string;
}

export interface Provider {
  /** Tool name as invoked on PATH (`docker`, `k3d`, `kubectl`). */
  name: string;
  /** One-line description shown in status/install output. */
  description: string;
  /**
   * When true, the local runtime cannot start without this tool;
   * `appliance local install` (no args) targets exactly these.
   */
  required: boolean;
  /**
   * Whether `install()` can ship a working binary without manual
   * steps from the user. False for providers that only point at
   * upstream installers (docker engine).
   */
  autoInstallable: boolean;
  /** Probe the system for this tool. Never throws. */
  check(ctx: Context): Promise<CheckResult>;
  /**
   * Install (or update) the tool to `ctx.binDir`. Implementations
   * MUST be idempotent and atomic — write to a temp file in the
   * same dir and rename into place on success. Throw on hard failure
   * so the orchestrator can surface a clear error.
   *
   * Only called when `autoInstallable` is true. The orchestrator
   * skips it for guidance-only providers and reports manualInstall()
   * to the user instead.
   */
  install?(ctx: Context, opts?: { version?: string }): Promise<void>;
  /**
   * Platform-specific install guidance for tools that can't be
   * auto-installed (docker engine) and as a fallback when auto-
   * install fails. Returned per provider so the caller doesn't
   * branch on tool name.
   */
  manualInstall(ctx: Context): ManualInstall;
}
