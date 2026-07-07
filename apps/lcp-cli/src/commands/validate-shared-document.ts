import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { validateSharedDocumentAction } from '../lib/storage/validate-shared-document.action';

/** Registers the `validate-shared-document` command. */
export function registerValidateSharedDocument(program: Command): void {
  program
    .command('validate-shared-document')
    .description(
      'Validate one or more documents already in shared storage (path or glob)',
    )
    .requiredOption(
      '--path <path>',
      'Object key or glob pattern (*, ?) to validate',
    )
    .option(
      '--recursive',
      'Include nested entries under a directory/glob prefix (default: immediate children only)',
    )
    .action((cmdOpts: { path: string; recursive?: boolean }) =>
      validateSharedDocumentAction(getGlobalOptions(program), cmdOpts),
    );
}
