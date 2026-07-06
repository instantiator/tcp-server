import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listRoleDocumentsAction } from '../lib/docs/list-role-documents.action';

/**
 * Lists OKF knowledge-base documents stored for a role.
 *
 * stdout: JSON array of `{ key, name, size, lastModified }` objects.
 * An empty array is printed when the role has no documents.
 */
export function registerListRoleDocuments(program: Command): void {
  program
    .command('list-role-documents')
    .description('List knowledge-base documents stored for a role')
    .requiredOption('-r, --role-id <uuid>', 'Role UUID')
    .action((cmdOpts: { roleId: string }) =>
      listRoleDocumentsAction(getGlobalOptions(program), cmdOpts),
    );
}
