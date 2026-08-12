import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { uploadSharedDocumentAction } from '../lib/docs/upload-shared-document.action';

/**
 * Uploads a local file to shared company storage.
 *
 * `--source` is the local file to upload; `--target` is the destination
 * MinIO object key (e.g. `acme/tasks/xyz/output/report.md`).
 */
export function registerUploadSharedDocument(program: Command): void {
  program
    .command('upload-shared-document')
    .description('Upload a file to shared company storage')
    .requiredOption('--source <path>', 'Local file to upload')
    .requiredOption(
      '--target <path>',
      'Destination object key in shared storage',
    )
    .action((cmdOpts: { source: string; target: string }) =>
      uploadSharedDocumentAction(getGlobalOptions(program), cmdOpts),
    );
}
