import { RESOURCES_DIR } from '@tcp/shared';
import { storagePrompts } from '../storage-prompts';
import { fill } from './fill';

/**
 * Path segment names reserved by the ADR-007 storage hierarchy
 * (`{company_slug}/tasks/{taskId}/assignments/{orderIndex}/working/...`).
 * A model-supplied filename containing one of these as a whole segment is
 * almost certainly a fully (or partially) resolved storage key echoed back
 * from a prompt, not a genuine subdirectory name — rejected below rather
 * than silently concatenated onto the working prefix, which would otherwise
 * write to a doubly-nested, wrong location.
 */
const RESERVED_PATH_SEGMENTS = new Set([
  'tasks',
  'assignments',
  'materials',
  'completed',
  'working',
]);

/**
 * Validates a model-supplied filename and joins it under a working prefix.
 * Rejects absolute paths, any `..` segment, a company-resource path, and any segment that looks like
 * a resolved storage-hierarchy path component, so a resolved key can never
 * escape the working directory — or land in an unintended nested one.
 *
 * @throws {Error} with a corrective message the tool relays to the model.
 */
export function resolveScopedKey(prefix: string, filename: string): string {
  const norm = filename.trim().replace(/\\/g, '/');
  if (norm === '') {
    throw new Error('A filename is required.');
  }
  if (norm.startsWith('/')) {
    throw new Error(`Filename must be relative, not absolute: '${filename}'.`);
  }
  const segments = norm.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(
      `Filename must not contain '..' path segments: '${filename}'.`,
    );
  }
  // Checked first: a resource path would otherwise hit the generic message.
  const resourcesAt = segments.indexOf(RESOURCES_DIR.replace('/', ''));
  if (resourcesAt >= 0) {
    throw new Error(
      fill(storagePrompts.working_file_is_resource, {
        filename,
        path: segments.slice(resourcesAt + 1).join('/'),
      }),
    );
  }
  if (segments.some((segment) => RESERVED_PATH_SEGMENTS.has(segment))) {
    throw new Error(
      `'${filename}' looks like a resolved storage path, not a bare filename. ` +
        `Pass just the filename shown in Materials/Expected outputs (e.g. 'report.md'), not a full storage key.`,
    );
  }
  return `${prefix}${norm}`;
}

/**
 * Resolves a model-supplied key or prefix inside the caller's company folder.
 * A path already under `companyPrefix` is used as-is; anything else is taken
 * as relative to it, so another company's files are unreachable whatever the
 * model passes. An empty path means the company folder itself.
 *
 * @throws {Error} with a corrective message the tool relays to the model.
 */
export function resolveCompanyKey(companyPrefix: string, path = ''): string {
  const norm = path.trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (norm.split('/').some((segment) => segment === '..')) {
    throw new Error(`Path must not contain '..' segments: '${path}'.`);
  }
  if (norm.startsWith('_deleted/')) {
    throw new Error(`Deleted files can't be read directly: '${path}'.`);
  }
  return norm.startsWith(companyPrefix) ? norm : `${companyPrefix}${norm}`;
}
