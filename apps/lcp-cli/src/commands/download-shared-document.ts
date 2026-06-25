import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import { apiDownload } from '../lib/api';
import { resolveToken } from '../lib/auth';

/**
 * Downloads a file from shared company storage to the local filesystem.
 *
 * `--source` is the MinIO object key (e.g. `acme/tasks/xyz/output/report.md`).
 * `--target` is the local destination path; defaults to `./<basename of source>`.
 *
 * stdout: `{ source, target, size }` JSON on success.
 */
export function registerDownloadSharedDocument(program: Command): void {
  program
    .command('download-shared-document')
    .description('Download a file from shared company storage')
    .requiredOption(
      '--source <path>',
      'Object key in shared storage (e.g. acme/tasks/out.md)',
    )
    .option(
      '--target <path>',
      'Local file path to write (default: ./<filename>)',
    )
    .action(async (cmdOpts: { source: string; target?: string }) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();
      try {
        process.stderr.write(`Downloading ${cmdOpts.source}...\n`);
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const api = { baseUrl: opts.lcpServer, token };

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
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
