import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveRoleId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Lists a role's memories, newest first.
 *
 * stdout: the JSON `{ memories, truncated, canWrite }` response.
 */
export function listMemoriesAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);
    const result = await apiRequest(api, 'GET', `/api/role/${roleId}/memory`);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
