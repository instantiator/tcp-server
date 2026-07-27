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
} from '@aws-sdk/client-s3';
import {
  AuditEventType,
  TcpCompany,
  registerDefaultValidators,
  streamToBuffer,
  validateDocument,
} from '@tcp/shared';
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import * as nodePath from 'path';
import { Readable } from 'stream';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { analyzeContent } from './content-analysis';
import { DocumentValidationException } from './document-validation.exception';
import {
  KnowledgeScope,
  knowledgeScopeKey,
  knowledgeScopePrefix,
} from './storage-keys';
import {
  assertValidStoragePath,
  DELETED_PREFIX,
  globToRegex,
  isNotFoundError,
  objectExists,
} from './storage-path-helpers';
import { Originators, StorageObject, StorageService } from './storage.service';

const DEFAULT_ORIGINATORS: Originators = {
  user: null,
  agent: null,
  task: null,
};

/**
 * MinIO/S3 implementation of {@link StorageService}.
 *
 * Uses a single shared bucket (`lcp` by default) with structured object keys
 * that follow the ADR-007 layout: `{company_slug}/knowledge/{role_slug}/{filename}`
 * (or `{company_slug}/knowledge/shared/{filename}` for company-wide knowledge).
 *
 * The bucket is created on startup if it does not already exist.
 */
@Injectable()
export class MinioStorageAdapter
  extends StorageService
  implements OnModuleInit
{
  private readonly logger = new Logger(MinioStorageAdapter.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @Inject(forwardRef(() => KnowledgeReindexService))
    private readonly reindex: KnowledgeReindexService,
  ) {
    super();
    registerDefaultValidators();
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

  /** Validates `content` before it's written to `path`, throwing on failure. */
  private async validateBeforeWrite(
    path: string,
    content: string,
  ): Promise<void> {
    const result = await validateDocument(path, content, (ref) =>
      this.resolveSchemaRef(path, ref),
    );
    if (!result.valid) {
      throw new DocumentValidationException(result.errors);
    }
  }

  /** Resolves a local/relative `$schema` reference against the document's own directory. */
  private async resolveSchemaRef(
    basePath: string,
    ref: string,
  ): Promise<string | null> {
    const refKey = nodePath.posix.join(nodePath.posix.dirname(basePath), ref);
    const result = await this.getByKey(refKey);
    if (!result) return null;
    const buf = await streamToBuffer(result.stream);
    return buf.toString('utf-8');
  }

  /**
   * Records a storage audit event with a real `companyId` resolved from the
   * key's leading slug segment. Skips (with a visible warning) rather than
   * writing a doomed nil-company-id event when no real company can be
   * resolved — see docs/prompts/009.4 §Risks (the previous nil-UUID
   * placeholder silently failed the FK constraint on every call).
   *
   * Never throws: the write/delete/copy/move it accompanies has already
   * succeeded by the time this runs, so an audit-side failure (e.g. a bad
   * `agentId` no longer present in `tcp_agent`) must not turn a successful
   * storage operation into a 500 for the caller — matches the fire-and-forget
   * guarantee `AuditClientService.record()` already gives HTTP callers.
   */
  private async emitStorageAudit(
    tool: string,
    path: string,
    companySlug: string,
    originators: Originators | undefined,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      const company = await this.companyRepo.findOneBy({ slug: companySlug });
      if (!company) {
        this.logger.warn(
          `Skipping storage audit for "${tool}" on ${path}: no company found for slug "${companySlug}"`,
        );
        return;
      }
      const resolvedOriginators = originators ?? DEFAULT_ORIGINATORS;
      await this.audit.record(
        company.id,
        'storage',
        resolvedOriginators.agent as UUID | null,
        AuditEventType.ToolCall,
        { tool, path, originators: resolvedOriginators, ...extra },
      );
    } catch (err) {
      this.logger.warn(
        `Storage audit write failed for "${tool}" on ${path}: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  /**
   * Enqueues a RAG rebuild for any affected key that falls under a
   * `knowledge/` folder — the single chokepoint that keeps embeddings in sync
   * with storage, whoever wrote the file (user, agent, or CLI). A no-op for
   * non-knowledge keys ({@link KnowledgeReindexService.bumpByKey} filters
   * them). Never throws: the write it accompanies has already succeeded, so a
   * queue-side failure must not turn it into an error for the caller.
   */
  private async triggerReindex(...keys: string[]): Promise<void> {
    for (const key of keys) {
      try {
        await this.reindex.bumpByKey(key);
      } catch (err) {
        this.logger.warn(
          `Knowledge reindex trigger failed for ${key}: ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    }
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

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

  async putKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
    content: Buffer | string,
    originators?: Originators,
  ): Promise<string> {
    const key = knowledgeScopeKey(scope, filename);
    const text =
      typeof content === 'string' ? content : content.toString('utf-8');
    await this.validateBeforeWrite(key, text);
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
    await this.emitStorageAudit(
      'put_knowledge_file',
      key,
      scope.companySlug,
      originators,
    );
    await this.triggerReindex(key);
    return key;
  }

  async listKnowledgeFiles(scope: KnowledgeScope): Promise<StorageObject[]> {
    const prefix = knowledgeScopePrefix(scope);
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
          etag: obj.ETag,
        });
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    return results;
  }

  async getKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
  ): Promise<string | null> {
    const key = knowledgeScopeKey(scope, filename);
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

  /**
   * Soft-deletes a knowledge-base document by delegating to {@link deleteFile}
   * — see docs/prompts/009.4 for why hard-delete was unified to soft-delete.
   */
  deleteKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
    originators?: Originators,
  ): Promise<void> {
    const key = knowledgeScopeKey(scope, filename);
    return this.deleteFile(key, originators);
  }

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
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async putByKey(
    key: string,
    data: Buffer,
    contentType: string,
    originators?: Originators,
  ): Promise<number> {
    await this.validateBeforeWrite(key, data.toString('utf-8'));
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType,
        ContentLength: data.length,
      }),
    );
    const companySlug = key.split('/')[0];
    await this.emitStorageAudit('put_by_key', key, companySlug, originators, {
      contentType,
    });
    await this.triggerReindex(key);
    return data.length;
  }

  async ensureBucketExists(): Promise<void> {
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

  // --- Full file-action surface (ported from lcp-mcp-storage's StorageToolsService) ---

  async listFiles(prefix?: string): Promise<StorageObject[]> {
    const resp = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix ?? '' }),
    );
    return (resp.Contents ?? [])
      .filter((obj) => !obj.Key?.startsWith(DELETED_PREFIX))
      .map((obj) => ({
        key: obj.Key ?? '',
        name: (obj.Key ?? '').split('/').at(-1) ?? '',
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
      }));
  }

  async readFile(path: string): Promise<string | null> {
    assertValidStoragePath(path);
    try {
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      const buf = await streamToBuffer(resp.Body as Readable);
      return buf.toString('utf-8');
    } catch (err) {
      if (isNotFoundError(err)) return null;
      throw err;
    }
  }

  async writeFile(
    path: string,
    content: string,
    overwrite = false,
    originators?: Originators,
  ): Promise<{ key: string; size: number }> {
    assertValidStoragePath(path);
    if (!overwrite && (await objectExists(this.client, this.bucket, path))) {
      throw new ConflictException(
        `File already exists at ${path}. Set overwrite: true to replace it.`,
      );
    }
    await this.validateBeforeWrite(path, content);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: content,
        ContentType: 'text/plain',
      }),
    );
    const companySlug = path.split('/')[0];
    await this.emitStorageAudit('write_file', path, companySlug, originators, {
      overwrite,
    });
    await this.triggerReindex(path);
    return { key: path, size: Buffer.byteLength(content, 'utf-8') };
  }

  async deleteFile(path: string, originators?: Originators): Promise<void> {
    assertValidStoragePath(path);
    if (!(await objectExists(this.client, this.bucket, path))) {
      throw new NotFoundException(`File not found: ${path}`);
    }
    // Soft delete: copy to _deleted/ prefix, then remove the original.
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${path}`,
        Key: `${DELETED_PREFIX}${path}`,
      }),
    );
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: path }),
    );
    const companySlug = path.split('/')[0];
    await this.emitStorageAudit('delete_file', path, companySlug, originators);
    await this.triggerReindex(path);
  }

  async restoreFile(path: string, originators?: Originators): Promise<void> {
    assertValidStoragePath(path);
    const deletedKey = `${DELETED_PREFIX}${path}`;
    if (!(await objectExists(this.client, this.bucket, deletedKey))) {
      throw new NotFoundException(
        `No soft-deleted file found at ${deletedKey}`,
      );
    }
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${deletedKey}`,
        Key: path,
      }),
    );
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: deletedKey }),
    );
    const companySlug = path.split('/')[0];
    await this.emitStorageAudit('restore_file', path, companySlug, originators);
    await this.triggerReindex(path);
  }

  async searchFiles(
    prefix?: string,
    pattern?: string,
  ): Promise<StorageObject[]> {
    const entries = await this.listFiles(prefix);
    if (!pattern) return entries;
    const re = globToRegex(pattern);
    return entries.filter((e) => re.test(e.key));
  }

  async getFileProperties(path: string): Promise<{
    key: string;
    exists: boolean;
    size?: number;
    contentType?: string;
    lastModified?: Date;
  }> {
    assertValidStoragePath(path);
    try {
      const resp = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      return {
        key: path,
        exists: true,
        size: resp.ContentLength,
        contentType: resp.ContentType,
        lastModified: resp.LastModified,
      };
    } catch (err) {
      if (isNotFoundError(err)) return { key: path, exists: false };
      throw err;
    }
  }

  async copyFile(
    source: string,
    destination: string,
    originators?: Originators,
  ): Promise<void> {
    assertValidStoragePath(source, 'source');
    assertValidStoragePath(destination, 'destination');
    if (!(await objectExists(this.client, this.bucket, source))) {
      throw new NotFoundException(`Source file not found: ${source}`);
    }
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${source}`,
        Key: destination,
      }),
    );
    const companySlug = source.split('/')[0];
    await this.emitStorageAudit('copy_file', source, companySlug, originators, {
      destination,
    });
    await this.triggerReindex(destination);
  }

  async moveFile(
    source: string,
    destination: string,
    originators?: Originators,
  ): Promise<void> {
    assertValidStoragePath(source, 'source');
    assertValidStoragePath(destination, 'destination');
    if (!(await objectExists(this.client, this.bucket, source))) {
      throw new NotFoundException(`Source file not found: ${source}`);
    }
    await this.client.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${source}`,
        Key: destination,
      }),
    );
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: source }),
    );
    const companySlug = source.split('/')[0];
    await this.emitStorageAudit('move_file', source, companySlug, originators, {
      destination,
    });
    await this.triggerReindex(source, destination);
  }

  async getFileSummary(path: string): Promise<Record<string, unknown>> {
    assertValidStoragePath(path);
    let content: string;
    let size: number | undefined;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      size = head.ContentLength;
      const resp = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      const buf = await streamToBuffer(resp.Body as Readable);
      content = buf.toString('utf-8');
    } catch (err) {
      if (isNotFoundError(err)) {
        throw new NotFoundException(`File not found: ${path}`);
      }
      throw err;
    }
    return analyzeContent(path, content, size);
  }

  async checkMissingFiles(paths: string[]): Promise<string[]> {
    const results = await Promise.all(
      paths.map(async (p) => ({
        path: p,
        exists: await objectExists(this.client, this.bucket, p),
      })),
    );
    return results.filter((r) => !r.exists).map((r) => r.path);
  }

  async validateExisting(path: string): Promise<{
    found: boolean;
    size: number;
    valid: boolean;
    errors: string[];
  }> {
    const content = await this.readFile(path);
    if (content === null) {
      return { found: false, size: 0, valid: true, errors: [] };
    }
    const result = await validateDocument(path, content, (ref) =>
      this.resolveSchemaRef(path, ref),
    );
    return {
      found: true,
      size: Buffer.byteLength(content, 'utf-8'),
      valid: result.valid,
      errors: result.errors.map((e) => e.llmHint),
    };
  }
}
