import { BadRequestException } from '@nestjs/common';
import { unzipSync, zipSync } from 'fflate';

/** Caps applied while reading an untrusted zip. */
export interface ZipLimits {
  /** Most entries (files and folders) the archive may hold. */
  maxEntries: number;
  /** Most bytes all entries may inflate to, in total. */
  maxUncompressedBytes: number;
}

/** A template's files, keyed by `/`-separated path relative to its root. */
export type TemplateFiles = Map<string, Uint8Array>;

/**
 * Unzips an untrusted archive into memory, refusing it before inflating
 * anything that would break {@link limits}.
 *
 * fflate sizes each output buffer from the size the central directory
 * declares and truncates anything beyond it, so summing declared sizes in
 * `filter` bounds memory even for an archive that lies about them.
 *
 * Folder entries are dropped, and macOS `__MACOSX/` and `.DS_Store` litter is
 * skipped. When every remaining path shares one top-level folder (a zipped
 * template directory), that folder is stripped.
 *
 * @throws {@link BadRequestException} for an unreadable archive, an unsafe
 * path, or a breached limit.
 */
export function readZip(buf: Uint8Array, limits: ZipLimits): TemplateFiles {
  let entries = 0;
  let total = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(buf, {
      filter: (file) => {
        entries += 1;
        total += file.originalSize;
        if (entries > limits.maxEntries) {
          throw new BadRequestException(
            `The zip holds more than ${limits.maxEntries} entries.`,
          );
        }
        if (total > limits.maxUncompressedBytes) {
          throw new BadRequestException(
            `The zip unpacks to more than ${limits.maxUncompressedBytes} bytes.`,
          );
        }
        assertSafePath(file.name);
        return !file.name.endsWith('/') && !isLitter(file.name);
      },
    });
  } catch (err) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException('The file is not a readable zip archive.');
  }
  return stripSharedRoot(new Map(Object.entries(raw)));
}

/** Zips a template's files. */
export function writeZip(files: TemplateFiles): Uint8Array {
  return zipSync(Object.fromEntries(files));
}

/** Refuses absolute paths, drive letters, backslashes and `..` segments. */
function assertSafePath(name: string): void {
  const unsafe =
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/.test(name) ||
    name.split('/').some((part) => part === '..');
  if (unsafe) {
    throw new BadRequestException(`Unsafe path in zip: ${name}`);
  }
}

/** Files that operating systems add to an archive without being asked. */
function isLitter(name: string): boolean {
  return name.startsWith('__MACOSX/') || name.split('/').pop() === '.DS_Store';
}

/** Removes a top-level folder that every path shares. */
function stripSharedRoot(files: TemplateFiles): TemplateFiles {
  const paths = [...files.keys()];
  const first = paths[0]?.split('/')[0];
  const shared =
    first !== undefined &&
    paths.every((p) => p.includes('/') && p.split('/')[0] === first);
  if (!shared) return files;
  return new Map(
    [...files].map(([p, data]) => [p.slice(first.length + 1), data]),
  );
}
