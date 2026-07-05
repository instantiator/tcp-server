import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
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
  cmdOpts: { roleId: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const docs = await apiRequest<DocumentSummary[]>(
      apiOptions(opts, token),
      'GET',
      `/api/role/${cmdOpts.roleId}/documents`,
    );
    process.stdout.write(JSON.stringify(docs, null, 2) + '\n');
  });
}
