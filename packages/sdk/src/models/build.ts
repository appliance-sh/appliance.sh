import { z } from 'zod';

/**
 * Builds are the unit of "what gets deployed". A build is created
 * from one of two sources, tracked as `BuildType`:
 *
 *   - `upload`       — a zip uploaded by the caller; content lives
 *                      at a derived S3 key in the cluster's data
 *                      bucket (`builds/<id>.zip`).
 *   - `remote-image` — a caller-supplied OCI image URI, e.g.
 *                      `ghcr.io/appliance-sh/api-server:1.28.1`.
 *                      Passed through to the deploy target as-is;
 *                      no upload or content fetch cluster-side.
 *
 * `POST /api/v1/builds` takes a discriminated body:
 *   - `{ type: 'upload' }` → response includes a presigned
 *     `uploadUrl` the caller PUTs their zip to.
 *   - `{ type: 'remote-image', uploadUrl: "<uri>" }` → response is
 *     `{ buildId }`; no upload needed.
 *
 * `uploadUrl` reads the same on both sides of the call — "the URL
 * where the content lives". The caller supplies it when content
 * already exists; the server mints a presigned one otherwise.
 */
export enum BuildType {
  Upload = 'upload',
  RemoteImage = 'remote-image',
}

export const buildCreateInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(BuildType.Upload),
  }),
  z.object({
    type: z.literal(BuildType.RemoteImage),
    uploadUrl: z.string(),
  }),
]);

export type BuildCreateInput = z.infer<typeof buildCreateInput>;

export const buildCreateResponse = z.object({
  buildId: z.string(),
  /** Presigned PUT URL; present only for `type: upload` builds. */
  uploadUrl: z.string().optional(),
});

export type BuildCreateResponse = z.infer<typeof buildCreateResponse>;

export const build = z.object({
  id: z.string(),
  type: z.nativeEnum(BuildType),
  /**
   * For `remote-image` builds: the caller-provided URL/URI, stored
   * verbatim and passed through to Lambda's imageUri at deploy time.
   * For `upload` builds: the internal S3 key (`builds/<id>.zip`)
   * the zip is expected at.
   */
  source: z.string(),
  createdAt: z.string(),
});

export type Build = z.infer<typeof build>;
