import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import type { ObjectStore } from '@appliance.sh/sdk';

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(bucketName: string, region?: string) {
    this.bucketName = bucketName;
    this.client = new S3Client({ region: region ?? 'us-east-1' });
  }

  async get(key: string): Promise<string | null> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      const response = await this.client.send(command);
      return (await response.Body?.transformToString()) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: value,
      ContentType: 'application/json',
    });
    await this.client.send(command);
  }

  async delete(key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    await this.client.send(command);
  }

  async list(prefix?: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const command = new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });
      const response = await this.client.send(command);

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            keys.push(object.Key);
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return keys;
  }
}
