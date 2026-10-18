import { BadRequestException } from '@nestjs/common';

/** Largest total a zip download may hold, before compression. */
export const MAX_ZIP_BYTES = 200 * 1024 * 1024; // 200 MB

/** Longest path the browser may name, relative to the company folder. */
const MAX_PATH_LENGTH = 1024;

/** The one folder people may change from the web client (002.05). */
const WRITABLE_ROOT = 'resources/';

/**
 * Turns a path relative to the company folder into a storage key, refusing
 * anything that could reach outside it. A folder path is `''` (the company
 * root) or ends in `/`; a file path doesn't end in `/`.
 *
 * @throws {@link BadRequestException} for an unsafe or malformed path.
 */
export function toCompanyKey(
  slug: string,
  path: string,
  kind: 'file' | 'folder',
): string {
  const bad = (why: string) =>
    new BadRequestException(`Invalid storage path: ${why}`);
  if (path.length > MAX_PATH_LENGTH) throw bad('too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw bad('bad character');
  if (path.startsWith('/')) throw bad('must be relative');
  if (kind === 'folder' && path !== '' && !path.endsWith('/')) {
    throw bad('a folder ends in /');
  }
  if (kind === 'file' && (path === '' || path.endsWith('/'))) {
    throw bad('a file does not end in /');
  }
  const segments = (kind === 'folder' ? path.slice(0, -1) : path).split('/');
  if (
    path !== '' &&
    segments.some((s) => s === '' || s === '.' || s === '..')
  ) {
    throw bad('empty, "." or ".." segment');
  }
  return `${slug}/${path}`;
}

/** Whether people may upload, delete or restore at `path` (a file or folder). */
export function isWritable(path: string): boolean {
  return path.startsWith(WRITABLE_ROOT);
}

/**
 * A folder's purpose: the first non-empty line of its `README.md`, without
 * heading marks. Mirrors `list_resources` in tcp-mcp-storage; copied, as apps
 * don't import from each other.
 */
export function purposeOf(readme: string): string {
  const first = readme.split('\n').find((l) => l.trim() !== '');
  return first?.replace(/^[#\s]+/, '').trim() ?? '';
}
