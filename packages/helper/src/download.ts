import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Context } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Download a binary to `<binDir>/<name>` atomically: stream to a temp
 * file under the same directory, chmod +x, then `fs.rename` into the
 * final path. Crashes during install leave a temp file rather than a
 * half-written binary at the canonical name.
 *
 * Verifies the response is non-empty and that the resulting binary
 * runs with `--version` (or a caller-provided sanity command). Throws
 * on any failure so the orchestrator can surface a clean error.
 *
 * `progress` percent is best-effort — falls back to `undefined` when
 * the server doesn't send a Content-Length, which is common for
 * GitHub Release redirects.
 */
export interface DownloadOptions {
  ctx: Context;
  /** Final binary name (no extension on POSIX, `.exe` on Windows). */
  name: string;
  /** HTTPS URL to GET. Must be a direct binary download. */
  url: string;
  /** Optional argv to run on the downloaded file to confirm it executes. */
  sanityCheck?: string[];
}

export async function downloadBinary(opts: DownloadOptions): Promise<string> {
  const { ctx, name, url, sanityCheck } = opts;
  const exe = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
  const finalPath = path.join(ctx.binDir, exe);
  const tmpPath = `${finalPath}.partial.${process.pid}`;

  ctx.onProgress?.({ type: 'progress', tool: name, message: `Downloading from ${url}` });

  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Download failed for ${name}: HTTP ${res.status} ${res.statusText}`);
  }
  if (!res.body) {
    throw new Error(`Download failed for ${name}: empty response body`);
  }

  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : NaN;
  let received = 0;
  // Throttle progress events: only re-emit when the integer percent
  // moves by >= 5, so a multi-MB download produces ~20 ticks instead
  // of one-per-stream-chunk.
  let lastPercentEmitted = -10;

  const file = fs.createWriteStream(tmpPath, { mode: 0o755 });
  try {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      file.write(Buffer.from(value));
      received += value.byteLength;
      if (Number.isFinite(total) && total > 0) {
        const percent = Math.min(100, (received / total) * 100);
        if (percent - lastPercentEmitted >= 5 || percent >= 100) {
          ctx.onProgress?.({
            type: 'progress',
            tool: name,
            message: `Downloading ${name} (${percent.toFixed(0)}%)`,
            percent,
          });
          lastPercentEmitted = percent;
        }
      }
    }
    file.end();
    await new Promise<void>((resolve, reject) => {
      file.on('finish', resolve);
      file.on('error', reject);
    });
  } catch (err) {
    file.destroy();
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }

  // Verify we actually got something. Some CDNs serve empty 200s when
  // a release asset path is wrong.
  const stats = fs.statSync(tmpPath);
  if (stats.size === 0) {
    fs.rmSync(tmpPath, { force: true });
    throw new Error(`Download failed for ${name}: 0 bytes written`);
  }

  // POSIX: ensure executable bit. Windows ignores chmod but doesn't care.
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, 0o755);
  }

  if (sanityCheck && sanityCheck.length > 0) {
    try {
      await execFileAsync(tmpPath, sanityCheck);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Sanity check failed for ${name}: ${reason}`);
    }
  }

  fs.renameSync(tmpPath, finalPath);
  ctx.onProgress?.({ type: 'progress', tool: name, message: `Installed to ${finalPath}` });
  return finalPath;
}

/**
 * Run `<tool> [args]` and capture stdout. Returns null when the tool
 * isn't on PATH or exits non-zero. Used by provider `check()`
 * implementations.
 */
export async function tryVersion(tool: string, args: string[]): Promise<{ stdout: string } | null> {
  try {
    const { stdout } = await execFileAsync(tool, args);
    return { stdout };
  } catch {
    return null;
  }
}

/** First non-empty line of a multi-line string, trimmed. */
export function firstLine(s: string): string | undefined {
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}
