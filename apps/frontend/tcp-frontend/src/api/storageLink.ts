import type { RuntimeConfig } from '../runtime-config';

/**
 * Builds the object-store console's URL for a task's completed-outputs
 * folder, or `null` without both `storageConsoleUrl` and `storageBucket`
 * configured — the archive tray then shows the task as plain text instead
 * of a link.
 *
 * The key layout mirrors `taskCompletedPrefix`
 * (`libs/tcp-shared/src/storage/artifact-keys.ts:51-56`): kept as a one-line
 * duplicate here rather than an import, because that module isn't exported
 * through `@tcp/shared/client` today — the frontend's runtime-free import
 * boundary (see that file's own comment for the rule).
 *
 * **Confirmed format** (002.02 stage 9, against a running Silo container —
 * `pgsty/silo`, the MinIO fork this stack bundles): `{consoleUrl}/browser/
 * {bucket}/{encodeURIComponent(prefix)}`, where `prefix` keeps its trailing
 * slash and is percent-encoded as a single path segment — `/` becomes `%2F`.
 * This is **not** MinIO's classic console format (a base64-encoded prefix);
 * a base64 prefix was tried against the same container and left the browser
 * on the bucket root, reading the encoded string as a literal (non-existent)
 * folder name. The percent-encoded form round-tripped correctly, listing the
 * target folder's contents.
 */
export function taskOutputsUrl(
  config: Pick<RuntimeConfig, 'storageConsoleUrl' | 'storageBucket'>,
  companySlug: string,
  taskId: string,
): string | null {
  const { storageConsoleUrl, storageBucket } = config;
  if (storageConsoleUrl === undefined || storageBucket === undefined) {
    return null;
  }
  const prefix = `${companySlug}/tasks/${taskId}/completed/`;
  const base = storageConsoleUrl.replace(/\/+$/, '');
  return `${base}/browser/${encodeURIComponent(storageBucket)}/${encodeURIComponent(prefix)}`;
}
