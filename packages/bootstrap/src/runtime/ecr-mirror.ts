import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import type { BootstrapEvent } from '../types';
import { login, pullImage, pushImage, tagImage } from './container';

interface MirrorOptions {
  /** Source image (e.g. `ghcr.io/appliance-sh/api-server:1.29.0`). */
  sourceImage: string;
  /** Cluster's ECR repository URL (from base config, e.g. `<acct>.dkr.ecr.<region>.amazonaws.com/<base>`). */
  ecrRepositoryUrl: string;
  /** Tag to push under in the cluster's ECR (e.g. the version). */
  tag: string;
  region: string;
  emit?: (e: BootstrapEvent) => void;
}

/**
 * Lambda's container image source must be in ECR — public registries
 * like GHCR aren't supported. The bootstrap orchestrator pulls the
 * api-server image from GHCR onto the operator's machine (where the
 * local api-server container runs from the same image), then mirrors
 * it into the cluster's ECR so the cloud Lambdas can pull it.
 *
 * Returns the immutable digest URI (preferred) or the tag URI if the
 * runtime doesn't expose a digest after push.
 */
export async function mirrorImageToEcr(opts: MirrorOptions): Promise<string> {
  const { sourceImage, ecrRepositoryUrl, tag, region, emit } = opts;

  pullImage(sourceImage, emit);

  emit?.({ type: 'log', level: 'info', message: `requesting ECR auth in ${region}` });
  const ecr = new ECRClient({ region });
  const authResult = await ecr.send(new GetAuthorizationTokenCommand({}));
  const authData = authResult.authorizationData?.[0];
  if (!authData?.authorizationToken || !authData?.proxyEndpoint) {
    throw new Error('Failed to obtain ECR authorization token');
  }
  const decoded = Buffer.from(authData.authorizationToken, 'base64').toString();
  const sep = decoded.indexOf(':');
  if (sep === -1) throw new Error('Malformed ECR authorization token');
  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);
  const registryHost = authData.proxyEndpoint.replace(/^https?:\/\//, '');

  login(registryHost, username, password);

  const remoteTag = `${ecrRepositoryUrl}:${tag}`;
  tagImage(sourceImage, remoteTag);
  pushImage(remoteTag, emit);

  return remoteTag;
}
