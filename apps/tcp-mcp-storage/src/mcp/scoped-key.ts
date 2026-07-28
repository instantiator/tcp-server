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
 * Rejects absolute paths, any `..` segment, and any segment that looks like
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
  if (segments.some((segment) => RESERVED_PATH_SEGMENTS.has(segment))) {
    throw new Error(
      `'${filename}' looks like a resolved storage path, not a bare filename. ` +
        `Pass just the filename shown in Materials/Expected outputs (e.g. 'report.md'), not a full storage key.`,
    );
  }
  return `${prefix}${norm}`;
}
