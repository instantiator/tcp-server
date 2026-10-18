/**
 * Whether people may change `path`. Mirrors `isWritable` in tcp-server's
 * `company-storage-paths.ts`: the server enforces it, this only shows it.
 */
export const isWritablePath = (path: string): boolean =>
  path.startsWith('resources/');

/** The folder holding `path` (a file, or a folder ending in `/`); `''` at the top. */
export const parentOf = (path: string): string =>
  path.slice(0, path.lastIndexOf('/', path.length - 2) + 1);
