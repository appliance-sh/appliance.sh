import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { VERSION } from '@appliance.sh/sdk';

// Staging of the api-server GUEST artifacts: the linux binary the
// microVM runs as its control plane, plus the web-console bundle it
// serves. The appliance-vm engine embeds whatever is staged at
// ~/.appliance/vm/images/guest-assets/ into the boot media — it never
// builds or downloads these itself, so this module is the single
// producer. No docker anywhere: the binary is a bun-compiled
// executable, delivered as a plain file.
//
// Resolution order:
//   1. APPLIANCE_API_SERVER_BINARY — explicit override, copied as-is.
//   2. Repo checkout — a prebuilt dist/guest binary, or a fresh
//      `bun build --compile` when bun is available.
//   3. GitHub release download pinned to this CLI's VERSION (the same
//      versioned-artifact convention the ghcr image used to follow).

const GUEST_ARCH: 'x64' | 'arm64' = process.arch === 'arm64' ? 'arm64' : 'x64';
const RELEASE_BASE = 'https://github.com/appliance-sh/appliance.sh/releases/download';

export function guestAssetsDir(): string {
  return path.join(os.homedir(), '.appliance', 'vm', 'images', 'guest-assets');
}

function stagedBinaryPath(): string {
  return path.join(guestAssetsDir(), 'appliance-api-server');
}

function stagedConsolePath(): string {
  return path.join(guestAssetsDir(), 'appliance-console.tar.gz');
}

function versionStampPath(): string {
  return path.join(guestAssetsDir(), 'appliance-api-server.version');
}

/** Repo layout probe, resolved relative to this module's emitted file
 *  (dist/utils → the repo's packages dir) — mirrors microvm-up's
 *  repoVmBinaryCandidates. Null under the bun single binary. */
function repoPackagesDir(): string | null {
  if (process.versions.bun) return null;
  try {
    const packagesDir = fileURLToPath(new URL('../../..', import.meta.url));
    return fs.existsSync(path.join(packagesDir, 'api-server', 'package.json')) ? packagesDir : null;
  } catch {
    return null;
  }
}

/**
 * Make sure the guest api-server binary (and console bundle, best
 * effort) are staged for the VM engine to embed. Idempotent and
 * version-stamped: a matching stamp short-circuits. Set
 * APPLIANCE_REBUILD_API_SERVER=1 to force a restage (repo iteration).
 */
export async function ensureApiServerArtifacts(): Promise<void> {
  const force = process.env.APPLIANCE_REBUILD_API_SERVER === '1';
  const stamp = `${VERSION}:${GUEST_ARCH}`;
  if (!force && fs.existsSync(stagedBinaryPath())) {
    try {
      if (fs.readFileSync(versionStampPath(), 'utf8').trim() === stamp) return;
    } catch {
      // no stamp — restage
    }
  }

  fs.mkdirSync(guestAssetsDir(), { recursive: true });

  const override = process.env.APPLIANCE_API_SERVER_BINARY;
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`APPLIANCE_API_SERVER_BINARY points at a missing file: ${override}`);
    }
    console.log(chalk.cyan(`» staging api-server guest binary from ${override}`));
    fs.copyFileSync(override, stagedBinaryPath());
    fs.writeFileSync(versionStampPath(), stamp);
    return;
  }

  const packagesDir = repoPackagesDir();
  if (packagesDir) {
    await stageFromRepo(packagesDir);
  } else {
    await stageFromRelease();
  }
  fs.writeFileSync(versionStampPath(), stamp);
}

async function stageFromRepo(packagesDir: string): Promise<void> {
  const apiServerDir = path.join(packagesDir, 'api-server');
  const prebuilt = path.join(apiServerDir, 'dist', 'guest', `appliance-api-server-linux-${GUEST_ARCH}`);

  if (!fs.existsSync(prebuilt) || process.env.APPLIANCE_REBUILD_API_SERVER === '1') {
    console.log(chalk.cyan(`» compiling api-server guest binary (linux-${GUEST_ARCH}, bun)`));
    const r = spawnSync(
      'bun',
      ['build', 'src/main.ts', '--compile', `--target=bun-linux-${GUEST_ARCH}-musl`, `--outfile=${prebuilt}`],
      { cwd: apiServerDir, stdio: 'inherit' }
    );
    if (r.status !== 0) {
      throw new Error(
        'could not compile the api-server guest binary. Install bun (https://bun.sh) and retry, ' +
          `or run \`pnpm --filter @appliance.sh/api-server compile:guest-${GUEST_ARCH}\` and try again, ` +
          'or point APPLIANCE_API_SERVER_BINARY at a prebuilt linux binary.'
      );
    }
  }
  fs.copyFileSync(prebuilt, stagedBinaryPath());
  console.log(chalk.dim(`staged api-server guest binary (${prebuilt})`));

  // Console bundle: best-effort — the API serves headless without it.
  const consoleDist = path.join(packagesDir, 'console', 'dist');
  if (fs.existsSync(path.join(consoleDist, 'index.html'))) {
    await tarGzDirectory(consoleDist, stagedConsolePath());
    console.log(chalk.dim('staged web console bundle'));
  } else {
    console.log(
      chalk.dim('console bundle not built (pnpm --filter @appliance.sh/console build) — the VM serves API only')
    );
  }
}

async function stageFromRelease(): Promise<void> {
  const version = VERSION.replace(/^v/, '');
  const binaryUrl = `${RELEASE_BASE}/v${version}/appliance-api-server-linux-${GUEST_ARCH}`;
  console.log(chalk.cyan(`» downloading api-server guest binary (${binaryUrl})`));
  try {
    await downloadTo(binaryUrl, stagedBinaryPath());
  } catch (err) {
    throw new Error(
      `could not download the api-server guest binary for v${version} (${(err as Error).message}).\n` +
        'Check network/GitHub access, or that this CLI version has a published release. ' +
        'Alternatively point APPLIANCE_API_SERVER_BINARY at a prebuilt linux binary.'
    );
  }

  // Console bundle: best-effort — the API serves headless without it.
  try {
    await downloadTo(`${RELEASE_BASE}/v${version}/appliance-console.tar.gz`, stagedConsolePath());
    console.log(chalk.dim('staged web console bundle'));
  } catch {
    console.log(chalk.dim('no console bundle in this release — the VM serves API only'));
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty artifact');
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, dest);
}

function tarGzDirectory(dir: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(dest);
    const archive = archiver('tar', { gzip: true });
    output.on('close', () => resolve());
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(dir, false);
    void archive.finalize();
  });
}
