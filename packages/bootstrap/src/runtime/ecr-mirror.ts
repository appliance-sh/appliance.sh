import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import type { BootstrapEvent } from '../types';
import { imageRepoDigest, login, pullImage, pushImage, tagImage } from './container';

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

  // Prefer the digest-pinned URI (`<repo>@sha256:...`) so Lambda
  // resolves to this exact push's content. Tag-only URIs leave the
  // Lambda holding whatever digest the *first* deploy resolved —
  // subsequent pushes that overwrite the tag don't trigger Pulumi
  // to update the function's image (the URI string didn't change),
  // and the Lambda keeps running the stale digest. Falling back to
  // the tag URI if RepoDigests isn't populated is fine for
  // first-deploy create paths; the symptom only matters on update.
  const digestUri = imageRepoDigest(remoteTag, ecrRepositoryUrl);
  if (digestUri) {
    emit?.({ type: 'log', level: 'info', message: `digest-pinned URI: ${digestUri}` });
    return digestUri;
  }
  emit?.({
    type: 'log',
    level: 'warn',
    message: `could not resolve digest for ${remoteTag}; falling back to tag-only URI (Lambda updates may not see future image changes)`,
  });
  return remoteTag;
}
