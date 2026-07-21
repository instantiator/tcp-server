import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveKnowledgeScopePath } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** Indexing status of a single knowledge scope. */
interface KnowledgeStatus {
  documentCount: number;
  totalBytes: number;
  chunkCount: number;
  generation: number;
  lastIndexedAt: string | null;
  indexing: boolean;
}

/** Indexing status for a whole company: its shared scope plus every role. */
interface CompanyKnowledgeStatus {
  shared: KnowledgeStatus;
  roles: { roleId: string; roleSlug: string; status: KnowledgeStatus }[];
}

/**
 * Reports knowledge-index status for a role, or for a company's shared
 * scope plus every role.
 *
 * stdout: JSON `KnowledgeStatus` (role scope) or `CompanyKnowledgeStatus`
 * (company scope).
 */
export function getKnowledgeIndexStatusAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const scopePath = await resolveKnowledgeScopePath(api, cmdOpts);
    const status = await apiRequest<KnowledgeStatus | CompanyKnowledgeStatus>(
      api,
      'GET',
      `/api/${scopePath}/knowledge/status`,
    );
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  });
}
