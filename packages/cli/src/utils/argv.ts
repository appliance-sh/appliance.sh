import { realpathSync } from 'node:fs';

/**
 * Extract the user-supplied tail of a process argv, dropping the
 * interpreter/binary slot (argv[0]) and the script slot (argv[1]).
 *
 * Invocation shapes we have to handle:
 *
 *   Node / Bun-as-interpreter:  [node, /path/to/appliance.js, ...userArgs]
 *   npm / Homebrew install:     [node, /opt/homebrew/bin/appliance, ...userArgs]
 *                               (argv[1] is an *extensionless symlink* to
 *                                dist/appliance.js — Node reports the
 *                                symlink path, not its target)
 *   Bun-compiled binary:        [binary, /$bunfs/root/appliance, ...userArgs]
 *                               (older Bun) or [binary, binary, ...userArgs]
 *                               (newer Bun)
 *
 * In every one of these argv[1] is a script/entry slot that isn't part
 * of what the user typed. The tricky case is the symlinked install: the
 * slot has no JS extension, so an extension test alone misses it and we
 * would wrongly treat the binary path as the first user argument (the
 * "Unknown command: /opt/homebrew/bin/appliance" bug). We resolve
 * symlinks before the extension test to cover it.
 *
 * `resolve` is injectable so the symlink branch is unit-testable without
 * touching the real filesystem; it defaults to `fs.realpathSync`.
 */
export function userArgs(argv: string[] = process.argv, resolve: (p: string) => string = realpathSync): string[] {
  const first = argv[1];
  if (!first) return argv.slice(1);

  // Bun standalone executable: argv[1] is the embedded entry under Bun's
  // virtual filesystem (POSIX `/$bunfs/`, Windows `B:\~BUN\` — reported
  // with either slash direction depending on the Bun release).
  if (first.startsWith('/$bunfs/') || /^B:[\\/]~BUN[\\/]/.test(first)) return argv.slice(2);

  // Newer Bun standalone executables repeat the binary path in argv[1]
  // instead of a `/$bunfs/` entry — it duplicates argv[0].
  if (first === argv[0]) return argv.slice(2);

  // Node / Bun-as-interpreter: argv[1] is the launched script. npm and
  // Homebrew install the CLI as an extensionless symlink
  // (`appliance` -> `dist/appliance.js`) and Node reports the symlink
  // path here, so resolve symlinks before testing for a JS/TS extension.
  let resolved = first;
  try {
    resolved = resolve(first);
  } catch {
    // argv[1] isn't a resolvable path (unusual harness); test the raw value.
  }
  if (/\.(?:js|cjs|mjs|ts)$/.test(resolved)) return argv.slice(2);

  // No recognizable script slot — assume argv[1] is already a user arg.
  return argv.slice(1);
}
