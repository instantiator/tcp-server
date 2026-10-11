import { RESOURCES_DIR } from './artifact-keys';

/** A model-supplied resource path, made safe, or the reason it can't be. */
export type ResourcePath = { path: string } | { error: string };

/**
 * Turns a model-supplied resource path into the path under `resources/`.
 * Forgiving where intent is clear: trims, turns `\` into `/`, collapses
 * repeated slashes, and strips a leading `/`, `resources/` or
 * `{companySlug}/resources/`. Refuses `..`, the soft-delete folder, and an
 * empty path. A file path may not end in `/`; a folder path (`folder: true`)
 * may, may be empty (the top folder), and comes back without a trailing `/`.
 */
export function normaliseResourcePath(
  raw: string | undefined,
  companySlug: string,
  { folder = false }: { folder?: boolean } = {},
): ResourcePath {
  let path = (raw ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
  path = path.replace(/^\//, '');
  for (const prefix of [`${companySlug}/${RESOURCES_DIR}`, RESOURCES_DIR]) {
    if (path.startsWith(prefix) || `${path}/` === prefix) {
      path = path.slice(prefix.length);
      break;
    }
  }
  const segments = path.split('/');
  if (segments.includes('..')) {
    return { error: `A resource path can't contain '..': '${raw}'.` };
  }
  if (segments.includes('_deleted')) {
    return { error: `Deleted files can't be reached here: '${raw}'.` };
  }
  if (folder) return { path: path.replace(/\/$/, '') };
  if (path === '') {
    return {
      error:
        "A resource path is required, e.g. 'price-list.md' or 'invoices/INV-0042.md'.",
    };
  }
  if (path.endsWith('/')) {
    return {
      error: `'${raw}' is a folder. Use list_resources to see its files, then pass a file path such as '${path}example.md'.`,
    };
  }
  return { path };
}
