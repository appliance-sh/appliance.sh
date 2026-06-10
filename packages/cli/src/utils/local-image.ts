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

import { execFileSync } from 'node:child_process';
import chalk from 'chalk';
import { DEFAULT_LOCAL_CLUSTER_NAME, importImageToCluster } from '@appliance.sh/helper';

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
    args.push('.');
    console.log(chalk.dim(`Building container: docker ${args.join(' ')}`));
    try {
      execFileSync('docker', args, { stdio: 'inherit' });
    } catch {
      throw new Error('Docker build failed.');
    }
  }

  let pushed = false;
  if (opts.registryUrl) {
    console.log(chalk.dim(`Pushing ${imageRef}`));
    try {
      execFileSync('docker', ['push', imageRef], { stdio: 'inherit' });
      pushed = true;
    } catch {
      console.log(chalk.yellow(`Push to ${opts.registryUrl} failed — falling back to k3d image import.`));
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
  return imageRef;
}
