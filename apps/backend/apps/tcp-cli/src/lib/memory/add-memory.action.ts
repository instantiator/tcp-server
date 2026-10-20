import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveRoleId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';
import { parseTags, RoleMemory } from './memory';

/**
 * Adds a memory to a role. `tags` is sent only when `--tags` is given.
 *
 * stdout: the created memory as JSON.
 */
export function addMemoryAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { content: string; tags?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);
    const body =
      cmdOpts.tags === undefined
        ? { content: cmdOpts.content }
        : { content: cmdOpts.content, tags: parseTags(cmdOpts.tags) };
    const memory = await apiRequest<RoleMemory>(
      api,
      'POST',
      `/api/role/${roleId}/memory`,
      body,
    );
    process.stdout.write(JSON.stringify(memory, null, 2) + '\n');
  });
}
