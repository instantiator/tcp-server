import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/**
 * Triggers a full RAG reindex of a company's knowledge (shared scope + every
 * role). The server responds 202 and rebuilds asynchronously on its reindex
 * worker.
 *
 * stdout: JSON `{ reindexing: true }`.
 */
export function reindexKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: { company?: string; companyId?: string; companySlug?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const companyIdentifier =
      cmdOpts.companyId ?? cmdOpts.companySlug ?? cmdOpts.company!;
    const result = await apiRequest<{ reindexing: true }>(
      api,
      'POST',
      `/api/company/${companyIdentifier}/knowledge/reindex`,
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  });
}
