import chalk from 'chalk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// Docker-free image builds via the microVM's in-guest buildkitd.
//
// The VM engine provisions buildkitd next to k3s and forwards its gRPC
// listener to a host loopback port (`kubernetes.buildkit.addr` in the
// base config, e.g. tcp://127.0.0.1:5054). `buildctl` — a managed
// binary like crane/kubectl — streams the build context over that
// connection (content-addressed + .dockerignore-aware, so rebuilds
// send only changed files), buildkitd builds with the dockerfile.v0
// frontend, and the result is pushed straight to the in-VM registry
// from inside the guest. No docker daemon, no image tar, no crane.

export interface BuildkitPublishOptions {
  /** Image name (the manifest's `name`). */
  name: string;
  /** linux/<arch> platform for the build, or undefined for default. */
  platform?: string;
  /** Build context directory (the appliance dir). */
  context: string;
  /** Registry the image is pushed to, e.g. `localhost:5052`. */
  registryUrl: string;
  /** buildkitd gRPC address, e.g. `tcp://127.0.0.1:5054`. */
  buildkitAddr: string;
}

/** Resolve (installing on first use) the managed buildctl binary.
 *  Returns null when it can't be provisioned — callers fall back to
 *  the docker build path. */
export async function ensureBuildctl(): Promise<string | null> {
  const { runInstall, helperBinDir } = await import('@appliance.sh/helper');
  try {
    const outcomes = await runInstall({ tools: ['buildctl'] });
    if (outcomes.find((o) => o.status === 'failed')) return null;
  } catch {
    return null;
  }
  const managed = path.join(helperBinDir(), process.platform === 'win32' ? 'buildctl.exe' : 'buildctl');
  return fs.existsSync(managed) ? managed : 'buildctl';
}

/** Whether a buildkitd answers at `addr`. Cheap (~2s bound) — the
 *  daemon installs in the guest background on first boot, so a fresh
 *  VM may say no for a minute; callers fall back to docker then. */
export function buildkitAvailable(buildctl: string, addr: string): boolean {
  const probe = spawnSync(buildctl, ['--addr', addr, 'debug', 'info'], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return probe.status === 0;
}

/** The buildctl argv for a dockerfile build pushed to the runtime
 *  registry. Pure — exported for tests. */
export function buildctlArgs(opts: BuildkitPublishOptions, metadataFile: string): string[] {
  return [
    '--addr',
    opts.buildkitAddr,
    'build',
    '--frontend',
    'dockerfile.v0',
    '--local',
    `context=${opts.context}`,
    '--local',
    `dockerfile=${opts.context}`,
    ...(opts.platform ? ['--opt', `platform=${opts.platform}`] : []),
    '--output',
    `type=image,name=${opts.registryUrl}/${opts.name}:latest,push=true,registry.insecure=true`,
    '--metadata-file',
    metadataFile,
  ];
}

/** Extract the pushed image digest from buildctl's --metadata-file
 *  JSON. Pure — exported for tests. */
export function parseBuildkitMetadata(json: string): string {
  const metadata = JSON.parse(json) as Record<string, unknown>;
  const digest = metadata['containerimage.digest'];
  if (typeof digest !== 'string' || !digest.startsWith('sha256:')) {
    throw new Error('buildctl metadata carried no containerimage.digest');
  }
  return digest;
}

/**
 * Build the appliance's Dockerfile inside the VM's buildkitd and push
 * the image to the runtime registry, returning the digest-qualified
 * ref (`<registry>/<name>@sha256:…`). Deploy-by-digest, exactly like
 * the crane path: a reused tag still rolls the Deployment, and an
 * unchanged build short-circuits as an idempotent no-op.
 */
export async function publishViaBuildkit(buildctl: string, opts: BuildkitPublishOptions): Promise<string> {
  const metadataFile = path.join(os.tmpdir(), `appliance-buildkit-${process.pid}.json`);
  try {
    // Inherit stdio: buildkit's live progress output is the build UX.
    const r = spawnSync(buildctl, buildctlArgs(opts, metadataFile), { stdio: 'inherit' });
    if (r.status !== 0) {
      throw new Error(`buildctl build failed (exit ${r.status ?? 'signal'}) — see the output above`);
    }
    const digest = parseBuildkitMetadata(fs.readFileSync(metadataFile, 'utf8'));
    const digestRef = `${opts.registryUrl}/${opts.name}@${digest}`;
    console.log(chalk.dim(`pushed ${digestRef}`));
    return digestRef;
  } finally {
    fs.rmSync(metadataFile, { force: true });
  }
}
