import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveKnowledgeScopePath } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Deletes a single OKF knowledge-base document by filename, from a role's
 * knowledge base or a company's shared knowledge. Idempotent — an unknown
 * filename is not an error.
 *
 * stdout: JSON `{ deleted: filename }`.
 */
export function deleteKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { file: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const scopePath = await resolveKnowledgeScopePath(api, cmdOpts);
    await apiRequest(
      api,
      'DELETE',
      `/api/${scopePath}/knowledge/${encodeURIComponent(cmdOpts.file)}`,
    );
    process.stdout.write(
      JSON.stringify({ deleted: cmdOpts.file }, null, 2) + '\n',
    );
  });
}
