import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'stream';

/** Summary of a single object returned by {@link MinioService.listKnowledgeFiles}. */
export interface StorageObject {
  /** Full object key (e.g. `acme/knowledge/analyst/report.md`). */
  key: string;
  /** Filename component (basename) extracted from the key. */
  name: string;
  /** Object size in bytes. */
  size: number;
  /** Last-modified timestamp. */
  lastModified: Date;
}

/**
 * Thin wrapper around the AWS S3 SDK pointed at MinIO.
 *
 * Uses a single shared bucket (`lcp` by default) with structured object keys
 * that follow the ADR-007 layout: `{company_slug}/knowledge/{role_name}/{filename}`.
 *
 * The bucket is created on startup if it does not already exist.
 */
@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const endpoint = this.config.getOrThrow<string>('MINIO_ENDPOINT');
    const accessKeyId = this.config.getOrThrow<string>('MINIO_ACCESS_KEY');
    const secretAccessKey = this.config.getOrThrow<string>('MINIO_SECRET_KEY');
    this.bucket = this.config.get<string>('MINIO_BUCKET_PREFIX') ?? 'lcp';

    this.client = new S3Client({
      endpoint,
      region: 'us-east-1', // MinIO requires a region string; value is ignored
      forcePathStyle: true, // Required for MinIO
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  /**
   * Writes arbitrary text content to a specific object key in the bucket.
   * The caller is responsible for constructing a safe, sanitised key.
   */
  async putRaw(key: string, body: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'text/plain',
      }),
    );
    this.logger.debug(`Stored raw object at ${key} (${body.length} chars)`);
  }

  /**
   * Uploads a document to the knowledge store for a role.
   *
   * Object key: `{companySlug}/knowledge/{roleName}/{filename}`.
   * Returns the full object key for use as {@link KnowledgeChunk.documentPath}.
   */
  async putKnowledgeFile(
    companySlug: string,
    roleName: string,
    filename: string,
    content: Buffer | string,
  ): Promise<string> {
    const key = this.knowledgeKey(companySlug, roleName, filename);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: 'text/markdown',
      }),
    );
    this.logger.debug(
      `Stored ${key} (${typeof content === 'string' ? content.length : content.byteLength} bytes)`,
    );
    return key;
  }

  /**
   * Returns all objects stored under `{companySlug}/knowledge/{roleName}/`.
   */
  async listKnowledgeFiles(
    companySlug: string,
    roleName: string,
  ): Promise<StorageObject[]> {
    const prefix = `${companySlug}/knowledge/${roleName}/`;
    const results: StorageObject[] = [];
    let continuationToken: string | undefined;

    do {
      const resp = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        results.push({
          key: obj.Key,
          name: obj.Key.slice(prefix.length),
          size: obj.Size ?? 0,
          lastModified: obj.LastModified ?? new Date(0),
        });
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    return results;
  }

  /**
   * Downloads a knowledge-base document and returns its text content.
   * Returns null when the object does not exist.
   */
  async getKnowledgeFile(
    companySlug: string,
    roleName: string,
    filename: string,
  ): Promise<string | null> {
    const key = this.knowledgeKey(companySlug, roleName, filename);
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const stream = resp.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array),
        );
      }
      return Buffer.concat(chunks).toString('utf-8');
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'NoSuchKey' || err.name === 'NotFound')
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Deletes a knowledge-base document.
   * Safe to call when the object does not exist (no-op).
   */
  async deleteKnowledgeFile(
    companySlug: string,
    roleName: string,
    filename: string,
  ): Promise<void> {
    const key = this.knowledgeKey(companySlug, roleName, filename);
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    this.logger.debug(`Deleted ${key}`);
  }

  private knowledgeKey(
    companySlug: string,
    roleName: string,
    filename: string,
  ): string {
    return `${companySlug}/knowledge/${roleName}/${filename}`;
  }

  /**
   * Returns the raw content stream and content-type for an arbitrary object key.
   * Resolves `null` when the key does not exist.
   */
  async getByKey(
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
      if (
        err instanceof Error &&
        (err.name === 'NoSuchKey' || err.name === 'NotFound')
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Writes arbitrary binary content to the given object key.
   * Returns the number of bytes written.
   */
  async putByKey(
    key: string,
    data: Buffer,
    contentType: string,
  ): Promise<number> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
      }),
    );
    return data.length;
  }

  private async ensureBucketExists(): Promise<void> {
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
}
