import {
  registerDefaultValidators,
  streamToBuffer,
  validateDocument,
} from '@tcp/shared';
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodePath from 'path';
import { Readable } from 'stream';
import { analyzeContent } from './content-analysis';
import { DocumentValidationException } from './document-validation.exception';
import { S3ObjectStore } from './s3-object-store';
import { StorageSideEffects } from './storage-side-effects.service';
import {
  KnowledgeScope,
  knowledgeScopeKey,
  knowledgeScopePrefix,
} from './storage-keys';
import {
  assertValidStoragePath,
  DELETED_PREFIX,
  globToRegex,
} from './storage-path-helpers';
import { Originators, StorageObject, StorageService } from './storage.service';

/**
 * MinIO/S3 implementation of {@link StorageService}.
 *
 * Uses a single shared bucket (`tcp` by default) with structured object keys
 * that follow the ADR-007 layout: `{company_slug}/knowledge/{role_slug}/{filename}`
 * (or `{company_slug}/knowledge/shared/{filename}` for company-wide knowledge).
 *
 * This class is the *policy* layer — path validation, document validation,
 * soft-delete, and the audit/reindex side effects. The object primitives it
 * builds on live in {@link S3ObjectStore}, and the side effects in
 * {@link StorageSideEffects}.
 *
 * The bucket is created on startup if it does not already exist.
 */
@Injectable()
export class MinioStorageAdapter
  extends StorageService
  implements OnModuleInit
{
  private readonly logger = new Logger(MinioStorageAdapter.name);
  private readonly store: S3ObjectStore;

  constructor(
    config: ConfigService,
    private readonly effects: StorageSideEffects,
  ) {
    super();
    registerDefaultValidators();
    this.store = new S3ObjectStore(config);
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucketExists();
  }

  async ensureBucketExists(): Promise<void> {
    await this.store.ensureBucket();
  }

  // Knowledge-base documents

  async putRaw(key: string, body: string): Promise<void> {
    await this.store.put(key, body, 'text/plain');
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
    await this.store.put(key, content, 'text/markdown');
    this.logger.debug(
      `Stored ${key} (${typeof content === 'string' ? content.length : content.byteLength} bytes)`,
    );
    await this.effects.recordAudit(
      'put_knowledge_file',
      key,
      scope.companySlug,
      originators,
    );
    await this.effects.triggerReindex(key);
    return key;
  }

  async listKnowledgeFiles(scope: KnowledgeScope): Promise<StorageObject[]> {
    const prefix = knowledgeScopePrefix(scope);
    const objects = await this.store.listAll(prefix);
    return objects
      .filter((obj) => obj.Key)
      .map((obj) => ({
        key: obj.Key!,
        name: obj.Key!.slice(prefix.length),
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ?? new Date(0),
        etag: obj.ETag,
      }));
  }

  async getKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
  ): Promise<string | null> {
    return this.store.getText(knowledgeScopeKey(scope, filename));
  }

  /**
   * Soft-deletes a knowledge-base document by delegating to {@link deleteFile}
   * — see docs/prompts/009.4 for why hard-delete was unified to soft-delete.
   */
  async deleteKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
    originators?: Originators,
  ): Promise<void> {
    return this.deleteFile(knowledgeScopeKey(scope, filename), originators);
  }

  // Raw key access (no path validation — callers hold already-resolved keys)

  async getByKey(
    key: string,
  ): Promise<{ stream: Readable; contentType: string } | null> {
    return this.store.get(key);
  }

  async putByKey(
    key: string,
    data: Buffer,
    contentType: string,
    originators?: Originators,
  ): Promise<number> {
    await this.validateBeforeWrite(key, data.toString('utf-8'));
    await this.store.put(key, data, contentType, data.length);
    await this.effects.recordAudit(
      'put_by_key',
      key,
      companySlugOf(key),
      originators,
      { contentType },
    );
    await this.effects.triggerReindex(key);
    return data.length;
  }

  // Generic file-action operations: list, read, write, delete, copy, move, search.

  async listFiles(prefix?: string): Promise<StorageObject[]> {
    const objects = await this.store.listPage(prefix ?? '');
    return objects
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
    return this.store.getText(path);
  }

  async writeFile(
    path: string,
    content: string,
    overwrite = false,
    originators?: Originators,
  ): Promise<{ key: string; size: number }> {
    assertValidStoragePath(path);
    if (!overwrite && (await this.store.exists(path))) {
      throw new ConflictException(
        `File already exists at ${path}. Set overwrite: true to replace it.`,
      );
    }
    await this.validateBeforeWrite(path, content);
    await this.store.put(path, content, 'text/plain');
    await this.effects.recordAudit(
      'write_file',
      path,
      companySlugOf(path),
      originators,
      { overwrite },
    );
    await this.effects.triggerReindex(path);
    return { key: path, size: Buffer.byteLength(content, 'utf-8') };
  }

  async deleteFile(path: string, originators?: Originators): Promise<void> {
    assertValidStoragePath(path);
    if (!(await this.store.exists(path))) {
      throw new NotFoundException(`File not found: ${path}`);
    }
    // Soft delete: copy to _deleted/ prefix, then remove the original.
    await this.store.copy(path, `${DELETED_PREFIX}${path}`);
    await this.store.remove(path);
    await this.effects.recordAudit(
      'delete_file',
      path,
      companySlugOf(path),
      originators,
    );
    await this.effects.triggerReindex(path);
  }

  async restoreFile(path: string, originators?: Originators): Promise<void> {
    assertValidStoragePath(path);
    const deletedKey = `${DELETED_PREFIX}${path}`;
    if (!(await this.store.exists(deletedKey))) {
      throw new NotFoundException(
        `No soft-deleted file found at ${deletedKey}`,
      );
    }
    await this.store.copy(deletedKey, path);
    await this.store.remove(deletedKey);
    await this.effects.recordAudit(
      'restore_file',
      path,
      companySlugOf(path),
      originators,
    );
    await this.effects.triggerReindex(path);
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

  async copyFile(
    source: string,
    destination: string,
    originators?: Originators,
  ): Promise<void> {
    await this.copyObjectChecked(source, destination);
    await this.effects.recordAudit(
      'copy_file',
      source,
      companySlugOf(source),
      originators,
      { destination },
    );
    await this.effects.triggerReindex(destination);
  }

  async moveFile(
    source: string,
    destination: string,
    originators?: Originators,
  ): Promise<void> {
    await this.copyObjectChecked(source, destination);
    await this.store.remove(source);
    await this.effects.recordAudit(
      'move_file',
      source,
      companySlugOf(source),
      originators,
      { destination },
    );
    // A move changes two keys, so both scopes must be reindexed — this is why
    // move is not "a copy that happens to delete afterwards".
    await this.effects.triggerReindex(source, destination);
  }

  // Inspection

  async getFileProperties(path: string): Promise<{
    key: string;
    exists: boolean;
    size?: number;
    contentType?: string;
    lastModified?: Date;
  }> {
    assertValidStoragePath(path);
    const head = await this.store.head(path);
    return head
      ? { key: path, exists: true, ...head }
      : { key: path, exists: false };
  }

  async getFileSummary(path: string): Promise<Record<string, unknown>> {
    assertValidStoragePath(path);
    const head = await this.store.head(path);
    const content = head === null ? null : await this.store.getText(path);
    if (head === null || content === null) {
      throw new NotFoundException(`File not found: ${path}`);
    }
    return analyzeContent(path, content, head.size);
  }

  async checkMissingFiles(paths: string[]): Promise<string[]> {
    const results = await Promise.all(
      paths.map(async (p) => ({
        path: p,
        exists: await this.store.exists(p),
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

  // Policy helpers

  /**
   * Validates both paths, refuses a missing source, and copies the object.
   *
   * Shared by {@link copyFile} and {@link moveFile}; each keeps its own audit
   * action and reindex call, because what a move means to the audit trail and
   * to the knowledge index is genuinely not "a copy that happens to delete
   * after".
   */
  private async copyObjectChecked(
    source: string,
    destination: string,
  ): Promise<void> {
    assertValidStoragePath(source, 'source');
    assertValidStoragePath(destination, 'destination');
    if (!(await this.store.exists(source))) {
      throw new NotFoundException(`Source file not found: ${source}`);
    }
    await this.store.copy(source, destination);
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
    const result = await this.store.get(refKey);
    if (!result) return null;
    const buf = await streamToBuffer(result.stream);
    return buf.toString('utf-8');
  }
}

/** The company slug an object key belongs to — its leading path segment. */
function companySlugOf(key: string): string {
  return key.split('/')[0];
}
