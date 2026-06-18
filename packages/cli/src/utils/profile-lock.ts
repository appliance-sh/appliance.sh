import * as fs from 'node:fs';
import * as path from 'node:path';

// Cross-process advisory lock around the shared profiles file. The CLI
// and the desktop both read-modify-write ~/.appliance/profiles.json
// (e.g. `appliance keys rotate` while the desktop reconciles at launch),
// so both take the same lockfile (<target>.lock) with the same protocol
// — mirrored in packages/desktop/src-tauri/src/lib.rs — and neither
// needs the other's language or any extra dependency:
//
//   * O_EXCL create (`wx`): exactly one contender, across processes, wins
//   * bounded spin with stale-lock cleanup (a crashed holder's lockfile
//     is reclaimed once it ages past the stale threshold)
//   * best-effort: on timeout (or an unexpected error) the caller
//     proceeds unlocked rather than fail a command — no worse than
//     before, since writeProfiles still writes via atomic temp-file
//     rename, so neither side can read a half-written file.

const STALE_MS = 30_000;
const TIMEOUT_MS = 2_000;
const SPIN_MS = 25;

/** Block the current thread for `ms` without busy-waiting. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lockfile older than the stale threshold is assumed abandoned by a
 *  crashed holder (real holds are well under a second); an unreadable
 *  mtime is treated as stale so a broken lock can never wedge us. */
function isStale(lockPath: string): boolean {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > STALE_MS;
  } catch {
    return true;
  }
}

/**
 * Run `fn` while holding the cross-process advisory lock on `target`
 * (the lockfile is `<target>.lock`). Releases the lock on every exit
 * path. Best-effort: if the lock can't be taken within the timeout, `fn`
 * still runs (unlocked) rather than throwing.
 */
export function withFileLock<T>(target: string, fn: () => T): T {
  const lockPath = `${target}.lock`;
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Directory creation is best-effort; openSync below reports the real
    // problem if the path is genuinely unusable.
  }

  const deadline = Date.now() + TIMEOUT_MS;
  let held = false;
  for (;;) {
    try {
      // 'wx' => O_EXCL: throws EEXIST if the lockfile already exists.
      fs.closeSync(fs.openSync(lockPath, 'wx'));
      held = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        break; // unexpected error — proceed unlocked rather than fail
      }
      if (isStale(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Another contender reclaimed it first — just retry.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        break; // best-effort: proceed unlocked
      }
      sleepSync(SPIN_MS);
    }
  }

  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already gone (e.g. reclaimed as stale) — nothing to do.
      }
    }
  }
}
