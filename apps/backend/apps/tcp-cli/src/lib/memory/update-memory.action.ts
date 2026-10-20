import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveRoleId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';
import { parseTags, RoleMemory } from './memory';

/**
 * Updates a role's memory, sending only the fields given. Fails without
 * making a request when neither `--content` nor `--tags` is given.
 *
 * stdout: the updated memory as JSON.
 */
export function updateMemoryAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { id: string; content?: string; tags?: string },
): Promise<void> {
  return runCommand(async () => {
    if (cmdOpts.content === undefined && cmdOpts.tags === undefined) {
      throw new Error('Provide --content, --tags, or both to update');
    }
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);
    const body = {
      ...(cmdOpts.content !== undefined && { content: cmdOpts.content }),
      ...(cmdOpts.tags !== undefined && { tags: parseTags(cmdOpts.tags) }),
    };
    const memory = await apiRequest<RoleMemory>(
      api,
      'PATCH',
      `/api/role/${roleId}/memory/${encodeURIComponent(cmdOpts.id)}`,
      body,
    );
    process.stdout.write(JSON.stringify(memory, null, 2) + '\n');
  });
}
