import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  _Object,
} from '@aws-sdk/client-s3';
import { streamToBuffer } from '@tcp/shared';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';
import { isNotFoundError } from './storage-path-helpers';

/** What `HeadObject` tells us about an object that exists. */
export interface ObjectHead {
  size?: number;
  contentType?: string;
  lastModified?: Date;
}

/**
 * The MinIO/S3 transport layer: one bucket, and the object primitives
 * {@link MinioStorageAdapter} builds its policy (validation, soft-delete,
 * audit, reindex) on top of.
 *
 * Nothing here knows about the ADR-007 key layout or about knowledge documents
 * — it takes keys and returns bytes. "Not found" is reported as `null` rather
 * than thrown, so callers decide whether an absent object is an error.
 */
export class S3ObjectStore {
  private readonly logger = new Logger(S3ObjectStore.name);
  private readonly client: S3Client;
  readonly bucket: string;

  constructor(config: ConfigService) {
    const endpoint = config.getOrThrow<string>('MINIO_ENDPOINT');
    const accessKeyId = config.getOrThrow<string>('MINIO_ACCESS_KEY');
    const secretAccessKey = config.getOrThrow<string>('MINIO_SECRET_KEY');
    this.bucket = config.get<string>('MINIO_BUCKET_PREFIX') ?? 'tcp';

    this.client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO requires a region string; value is ignored
      forcePathStyle: true, // Required for MinIO
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /** Creates the bucket if it does not already exist. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err) {
      // If the bucket simply doesn't exist, create it. Any other error (e.g.
      // MinIO unreachable in tests) is logged and swallowed so the module can
      // still initialise — operations will fail at call time with clear errors.
      if (
        err instanceof Error &&
        (err.name === 'NoSuchBucket' ||
          err.name === 'NotFound' ||
          err.name === 'NoSuchKey')
      ) {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        this.logger.log(`Created MinIO bucket: ${this.bucket}`);
      } else {
        this.logger.warn(
          `Could not verify MinIO bucket "${this.bucket}": ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    }
  }

  /** Writes an object, replacing anything already at `key`. */
  async put(
    key: string,
    body: Buffer | string,
    contentType: string,
    contentLength?: number,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ...(contentLength !== undefined && { ContentLength: contentLength }),
      }),
    );
  }

  /** Opens an object as a stream, or `null` when it does not exist. */
  async get(
    key: string,
  ): Promise<{ stream: Readable; contentType: string } | null> {
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        stream: resp.Body as Readable,
        contentType: resp.ContentType ?? 'application/octet-stream',
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /** Reads an object as UTF-8 text, or `null` when it does not exist. */
  async getText(key: string): Promise<string | null> {
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const buf = await streamToBuffer(resp.Body as Readable);
      return buf.toString('utf-8');
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /** Object metadata, or `null` when it does not exist. */
  async head(key: string): Promise<ObjectHead | null> {
    try {
      const resp = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        size: resp.ContentLength,
        contentType: resp.ContentType,
        lastModified: resp.LastModified,
      };
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  /**
   * Whether an object exists at `key`. Unlike {@link head}, any error at all
   * counts as "no" — this backs pre-flight checks where the caller is about to
   * write, and a transport failure will surface from the write itself.
   */
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** The first page of objects under `prefix`. */
  async listPage(prefix: string): Promise<_Object[]> {
    const resp = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix }),
    );
    return resp.Contents ?? [];
  }

  /** Every object under `prefix`, following continuation tokens to the end. */
  async listAll(prefix: string): Promise<_Object[]> {
    const results: _Object[] = [];
    let continuationToken: string | undefined;
    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      results.push(...(resp.Contents ?? []));
      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);
    return results;
  }

  /** Server-side copy within the bucket. */
  async copy(source: string, destination: string): Promise<void> {
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${source}`,
        Key: destination,
      }),
    );
  }

  /** Hard-deletes an object. Soft-delete is the adapter's policy, not this. */
  async remove(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }
}
