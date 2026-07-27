import * as fs from 'fs';
import * as path from 'path';
import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiDownload } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Downloads a file from shared company storage to the local filesystem.
 *
 * `--source` is the MinIO object key (e.g. `acme/tasks/xyz/output/report.md`).
 * `--target` is the local destination path; defaults to `./<basename of source>`.
 *
 * stdout: `{ source, target, size }` JSON on success.
 */
export function downloadSharedDocumentAction(
  opts: GlobalOptions,
  cmdOpts: { source: string; target?: string },
): Promise<void> {
  return runCommand(async () => {
    process.stderr.write(`Downloading ${cmdOpts.source}...\n`);
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const encodedPath = encodeURIComponent(cmdOpts.source);
    const { data, filename } = await apiDownload(
      api,
      `/api/storage?path=${encodedPath}`,
    );

    const target = cmdOpts.target ?? `./${filename}`;
    fs.writeFileSync(target, data);

    process.stderr.write(`Saved to ${path.resolve(target)}\n`);
    process.stdout.write(
      JSON.stringify(
        {
          source: cmdOpts.source,
          target: path.resolve(target),
          size: data.length,
        },
        null,
        2,
      ) + '\n',
    );
  });
}
