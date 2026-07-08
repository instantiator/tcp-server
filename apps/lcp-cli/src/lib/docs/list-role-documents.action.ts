import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { RoleIdentifierOpts, resolveRoleId } from '../core/resolve-identifiers';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/**
 * Lists OKF knowledge-base documents stored for a role.
 *
 * stdout: JSON array of `{ key, name, size, lastModified }` objects.
 * An empty array is printed when the role has no documents.
 */
export function listRoleDocumentsAction(
  opts: GlobalOptions,
  cmdOpts: RoleIdentifierOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);
    const docs = await apiRequest<DocumentSummary[]>(
      api,
      'GET',
      `/api/role/${roleId}/documents`,
    );
    process.stdout.write(JSON.stringify(docs, null, 2) + '\n');
  });
}
