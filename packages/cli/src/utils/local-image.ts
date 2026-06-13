// Build-and-publish pipeline for Kubernetes-base deploys. Cloud bases
// take an uploaded appliance.zip and build server-side; Kubernetes
// bases (local k3d, BYO clusters) deploy container images directly —
// the in-cluster api-server has no docker daemon, so image production
// is a host-side concern. This mirrors the desktop's
// `build_and_import_image` Tauri command: build the image, push it to
// the cluster-attached registry when one exists, and import it into
// the k3d containerd store as a fallback for clusters whose
// registries.yaml doesn't mirror the registry (`--registry-use` only
// takes effect at cluster create time).

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import chalk from 'chalk';
import { DEFAULT_LOCAL_CLUSTER_NAME, helperBinDir, importImageToCluster, runInstall } from '@appliance.sh/helper';

export interface PublishLocalImageOptions {
  /** Appliance name — becomes the image repository name. */
  name: string;
  /** Docker platform (e.g. linux/amd64). */
  platform?: string;
  /** User-supplied build script. When present it is expected to have
   *  produced an image tagged `<name>` already (same contract as the
   *  zip pipeline's packageContainer). */
  buildScript?: string;
  /** Cluster-attached registry (e.g. `localhost:5050`), or null when
   *  the base has none. */
  registryUrl: string | null;
  /** k3d cluster to import into as a fallback. */
  clusterName?: string;
  /** Docker build context (the appliance directory). Defaults to cwd,
   *  so `appliance deploy -d app/` builds `app/`'s Dockerfile rather
   *  than looking in the current directory. */
  context?: string;
}

/**
 * Build the appliance image and make it runnable by the cluster.
 * Returns the image reference to register as a remote-image build.
 */
export async function publishLocalApplianceImage(opts: PublishLocalImageOptions): Promise<string> {
  const localTag = `${opts.name}:latest`;
  const imageRef = opts.registryUrl ? `${opts.registryUrl}/${localTag}` : localTag;

  if (opts.buildScript) {
    // The user's build script produced `<name>`; just retag when a
    // registry-qualified ref is needed.
    if (imageRef !== localTag) {
      execFileSync('docker', ['tag', opts.name, imageRef], { stdio: 'inherit' });
    }
  } else {
    const args = ['build', '--provenance=false', '-t', imageRef];
    if (opts.platform) args.push('--platform', opts.platform);
    args.push(opts.context ?? '.');
    console.log(chalk.dim(`Building container: docker ${args.join(' ')}`));
    try {
      execFileSync('docker', args, { stdio: 'inherit' });
    } catch {
      throw new Error('Docker build failed.');
    }
  }

  let pushed = false;
  let publishedRef = imageRef;
  if (opts.registryUrl) {
    console.log(chalk.dim(`Pushing ${imageRef}`));
    try {
      execFileSync('docker', ['push', imageRef], { stdio: 'inherit' });
      pushed = true;
    } catch {
      // `docker push` executes inside the docker VM (colima/Desktop),
      // where the host's 127.0.0.1 registries (the microVM engine's
      // forwarded registry) don't exist. Retry host-side with crane —
      // which also returns a digest ref, making redeploys roll even
      // under a reused tag.
      console.log(chalk.dim('docker push failed — retrying host-side with crane'));
      try {
        publishedRef = await cranePush(imageRef);
        pushed = true;
        console.log(chalk.dim(`pushed ${publishedRef}`));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`Registry push failed (${message}) — falling back to k3d image import.`));
      }
    }
  }

  // Import into the cluster's containerd store regardless of push
  // outcome: with `imagePullPolicy: IfNotPresent` the imported copy
  // makes the deploy independent of registry mirror configuration,
  // which older clusters lack. Best-effort — a BYO (non-k3d) cluster
  // has nothing to import into.
  let imported = false;
  try {
    imported = await importImageToCluster(imageRef, opts.clusterName ?? DEFAULT_LOCAL_CLUSTER_NAME);
    if (imported) console.log(chalk.dim(`Imported ${imageRef} into the cluster`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(chalk.dim(`k3d image import skipped: ${message}`));
  }

  if (!pushed && !imported) {
    throw new Error(
      `Could not deliver ${imageRef} to the cluster: no reachable registry and k3d image import failed. ` +
        'Check that the cluster is running (`appliance local status`).'
    );
  }
  return publishedRef;
}

/** Push a daemon-held image to its registry from the host process via
 *  `docker save` + `crane push`. Returns the digest-qualified ref. */
async function cranePush(imageRef: string): Promise<string> {
  const outcomes = await runInstall({ tools: ['crane'] });
  const failed = outcomes.find((o) => o.status === 'failed');
  if (failed) throw new Error(`crane install failed: ${failed.message}`);
  const managed = path.join(helperBinDir(), 'crane');
  const crane = fs.existsSync(managed) ? managed : 'crane';

  const tarPath = path.join(os.tmpdir(), `appliance-image-${process.pid}.tar`);
  try {
    execFileSync('docker', ['save', '-o', tarPath, imageRef], { stdio: 'inherit' });
    const r = spawnSync(crane, ['push', '--insecure', tarPath, imageRef], {
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) throw new Error('crane push failed');
    const lines = r.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const digestRef = lines[lines.length - 1];
    if (!digestRef || !digestRef.includes('@sha256:')) {
      throw new Error('could not parse digest from crane output');
    }
    return digestRef;
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
}
