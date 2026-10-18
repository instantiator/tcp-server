import { Readable } from 'stream';
import type { KnowledgeScope } from './storage-keys';

/** Summary of a single stored object (e.g. returned by {@link StorageService.listKnowledgeFiles}). */
export interface StorageObject {
  /** Full object key (e.g. `acme/knowledge/analyst/report.md`). */
  key: string;
  /** Filename component (basename) extracted from the key. */
  name: string;
  /** Object size in bytes. */
  size: number;
  /** Last-modified timestamp. */
  lastModified: Date;
  /** Entity tag (content hash) of the object, when the backend reports one. */
  etag?: string;
}

/** Who/what requested a storage action, threaded through for audit attribution. */
/** One stored version of an object, from a versioned bucket. */
export interface StorageVersion {
  versionId: string;
  size: number;
  lastModified: Date;
  /** Whether this is the object's current version. */
  isLatest: boolean;
}

export interface Originators {
  /** JWT `sub` of the human user, for direct (JWT-guarded) calls. `null` for agent-initiated calls. */
  user: string | null;
  /** Agent id, for MCP-tool-initiated calls. `null` for direct human/CLI calls. */
  agent: string | null;
  /** The task the platform acted for (applying its resource changes); otherwise `null` — see ADR-008. */
  task: string | null;
}

/**
 * General storage interface for the shared document store.
 *
 * `MinioStorageAdapter` is the only implementation today, but the interface
 * is deliberately storage-backend-agnostic — a future adapter (e.g. Google
 * Drive) would implement the same contract without touching any caller.
 *
 * All writes are validated before being accepted — see
 * `libs/tcp-shared/src/storage/validation/`.
 */
export abstract class StorageService {
  /** Writes arbitrary text content to a specific object key. Not validated — used for internal/system writes (e.g. context overflow), not user-facing documents. */
  abstract putRaw(key: string, body: string): Promise<void>;

  /** Uploads a document to the knowledge store for the given scope (a role, or company-shared). Returns the full object key. */
  abstract putKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
    content: Buffer | string,
    originators?: Originators,
  ): Promise<string>;

  /** Returns all objects stored under the given knowledge scope's directory. */
  abstract listKnowledgeFiles(scope: KnowledgeScope): Promise<StorageObject[]>;

  /** Downloads a knowledge-base document's text content. Returns `null` when it does not exist. */
  abstract getKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
  ): Promise<string | null>;

  /** Soft-deletes a knowledge-base document (see {@link deleteFile}). Safe to call when the object does not exist. */
  abstract deleteKnowledgeFile(
    scope: KnowledgeScope,
    filename: string,
    originators?: Originators,
  ): Promise<void>;

  /** Returns the raw content stream and content-type for an arbitrary object key (or one of its old versions), or `null` if it does not exist. */
  abstract getByKey(
    key: string,
    versionId?: string,
  ): Promise<{ stream: Readable; contentType: string } | null>;

  /** Writes arbitrary binary content to the given object key. Returns the number of bytes written. */
  abstract putByKey(
    key: string,
    data: Buffer,
    contentType: string,
    originators?: Originators,
  ): Promise<number>;

  /** Ensures the backing bucket/container exists, creating it if necessary. */
  abstract ensureBucketExists(): Promise<void>;

  /**
   * Lists objects under an optional prefix (excludes soft-deleted objects).
   * Returns the first page only, unless `all` asks for every key.
   */
  abstract listFiles(
    prefix?: string,
    options?: { all?: boolean },
  ): Promise<StorageObject[]>;

  /**
   * One folder level under `prefix` (excludes soft-deleted objects): the
   * immediate subfolders' prefixes, and the files directly inside it.
   */
  abstract listFolder(
    prefix: string,
  ): Promise<{ folders: string[]; files: StorageObject[] }>;

  /** Every kept version of the object at `key`, newest first. */
  abstract listVersions(key: string): Promise<StorageVersion[]>;

  /**
   * Makes an old version of `key` its current one, by copying it over the
   * top: the version it replaces is kept, so a restore can itself be undone.
   */
  abstract restoreVersion(
    key: string,
    versionId: string,
    originators?: Originators,
  ): Promise<void>;

  /** Reads an object's content as text. Returns `null` when it does not exist. */
  abstract readFile(path: string): Promise<string | null>;

  /** Writes text content to an object key, subject to document validation. */
  abstract writeFile(
    path: string,
    content: string,
    overwrite?: boolean,
    originators?: Originators,
  ): Promise<{ key: string; size: number }>;

  /** Soft-deletes an object (moved to a recoverable location). Reversed by {@link restoreFile}. */
  abstract deleteFile(path: string, originators?: Originators): Promise<void>;

  /** Restores a previously soft-deleted object. */
  abstract restoreFile(path: string, originators?: Originators): Promise<void>;

  /** Lists objects under an optional prefix, filtered by an optional glob pattern. */
  abstract searchFiles(
    prefix?: string,
    pattern?: string,
  ): Promise<StorageObject[]>;

  /** Returns existence/metadata for a single object without fetching its content. */
  abstract getFileProperties(path: string): Promise<{
    key: string;
    exists: boolean;
    size?: number;
    contentType?: string;
    lastModified?: Date;
  }>;

  /** Copies an object to a new key. */
  abstract copyFile(
    source: string,
    destination: string,
    originators?: Originators,
  ): Promise<void>;

  /** Moves (copies then deletes) an object to a new key. */
  abstract moveFile(
    source: string,
    destination: string,
    originators?: Originators,
  ): Promise<void>;

  /** Returns a structural summary of an object's content (format-specific). */
  abstract getFileSummary(path: string): Promise<Record<string, unknown>>;

  /** Returns the subset of `paths` that do not exist in storage. */
  abstract checkMissingFiles(paths: string[]): Promise<string[]>;

  /**
   * Re-validates an already-stored document against the same rules enforced
   * at write time (see `libs/tcp-shared/src/storage/validation/`) — used by
   * the standalone `validate-shared-document` path, which exists because a
   * user could write to the backing store directly, bypassing this
   * service's write-time validation gate entirely.
   */
  abstract validateExisting(path: string): Promise<{
    found: boolean;
    size: number;
    valid: boolean;
    errors: string[];
  }>;
}
