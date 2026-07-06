import * as fs from 'fs';
import * as path from 'path';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiUpload } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** Guesses a MIME type from file extension (covers common doc formats). */
export function mimeFromExt(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.md':
      return 'text/markdown';
    case '.txt':
      return 'text/plain';
    case '.json':
      return 'application/json';
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Uploads a local file to shared company storage.
 *
 * `--source` is the local file to upload.
 * `--target` is the MinIO object key (e.g. `acme/tasks/xyz/output/report.md`).
 *
 * stdout: `{ key, size }` JSON on success.
 */
export function uploadSharedDocumentAction(
  opts: GlobalOptions,
  cmdOpts: { source: string; target: string },
): Promise<void> {
  return runCommand(async () => {
    const absSource = path.resolve(cmdOpts.source);
    if (!fs.existsSync(absSource)) {
      process.stderr.write(`Error: file not found: ${absSource}\n`);
      process.exit(1);
    }

    process.stderr.write(`Uploading ${absSource} → ${cmdOpts.target}...\n`);
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const data = fs.readFileSync(absSource);
    const contentType = mimeFromExt(absSource);
    const filename = path.basename(absSource);

    const result = await apiUpload<{ key: string; size: number }>(
      api,
      `/api/storage?path=${encodeURIComponent(cmdOpts.target)}`,
      filename,
      data,
      contentType,
    );

    process.stderr.write(`Uploaded ${result.size} bytes.\n`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
