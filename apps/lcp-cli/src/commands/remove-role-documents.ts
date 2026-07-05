import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { removeRoleDocumentsAction } from '../lib/docs/remove-role-documents.action';

/**
 * Removes OKF knowledge-base documents from a role by matching their names
 * against a set of patterns (`*` and `?` wildcards supported).
 */
export function registerRemoveRoleDocuments(program: Command): void {
  program
    .command('remove-role-documents')
    .description(
      'Remove knowledge-base documents from a role (supports * and ? wildcards)',
    )
    .requiredOption('-r, --role-id <uuid>', 'Role UUID')
    .requiredOption(
      '-p, --pattern <patterns...>',
      'One or more filename patterns to match (e.g. "*.md", "report-?.md")',
    )
    .action((cmdOpts: { roleId: string; pattern: string[] }) =>
      removeRoleDocumentsAction(getGlobalOptions(program), cmdOpts),
    );
}
