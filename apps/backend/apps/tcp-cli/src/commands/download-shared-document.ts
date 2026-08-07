import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { downloadSharedDocumentAction } from '../lib/docs/download-shared-document.action';

/**
 * Downloads a file from shared company storage to the local filesystem.
 *
 * `--source` is the MinIO object key; `--target` is the local destination
 * path (defaults to `./<basename of source>`).
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
    .action((cmdOpts: { source: string; target?: string }) =>
      downloadSharedDocumentAction(getGlobalOptions(program), cmdOpts),
    );
}
