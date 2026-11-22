import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { confirmAction } from '../core/confirm';
import { EntityRefOpts, resolveRoleId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Deletes one of a role's memories. Unless `--force` is given, asks for y/n
 * confirmation first; a declined confirmation makes no request.
 */
export function deleteMemoryAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { id: string; force?: boolean },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);

    if (!cmdOpts.force) {
      const confirmed = await confirmAction(`Delete memory ${cmdOpts.id}?`);
      if (!confirmed) {
        process.stderr.write('Aborted.\n');
        return;
      }
    }

    await apiRequest(
      api,
      'DELETE',
      `/api/role/${roleId}/memory/${encodeURIComponent(cmdOpts.id)}`,
    );
    process.stdout.write(`Deleted memory ${cmdOpts.id}\n`);
  });
}
