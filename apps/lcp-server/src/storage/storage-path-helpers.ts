import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BadRequestException } from '@nestjs/common';

/** Prefix under which soft-deleted files are stored (see `deleteFile`/`restoreFile`). */
export const DELETED_PREFIX = '_deleted/';

/**
 * Validates a storage path is safe: non-empty, no ".." segments, and not
 * directly targeting the soft-delete folder. Throws `BadRequestException`
 * (400) rather than returning a sentinel, matching REST conventions.
 */
export function assertValidStoragePath(path: string, label = 'path'): void {
  if (!path || path.includes('..')) {
    throw new BadRequestException(
      `Invalid ${label}: must be non-empty and must not contain "..".`,
    );
  }
  if (path.startsWith(DELETED_PREFIX)) {
    throw new BadRequestException(
      `Invalid ${label}: cannot directly access the soft-delete folder.`,
    );
  }
}

/** Checks whether an object exists at `key` via `HeadObject`. */
export async function objectExists(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/** Determines whether an S3/MinIO error represents "not found" (vs. a real failure). */
export function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name;
  return name === 'NoSuchKey' || name === 'NotFound' || name === '404';
}

/** Converts a simple glob pattern (`*`, `?`) into a RegExp matched against a full key. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  );
}
