import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveKnowledgeScopePath } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/**
 * Lists OKF knowledge-base documents stored for a role or a company's
 * shared knowledge.
 *
 * stdout: JSON array of `{ key, name, size, lastModified }` objects.
 * An empty array is printed when the scope has no documents.
 */
export function listKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);
    const scopePath = await resolveKnowledgeScopePath(api, cmdOpts);
    const docs = await apiRequest<DocumentSummary[]>(
      api,
      'GET',
      `/api/${scopePath}/knowledge`,
    );
    process.stdout.write(JSON.stringify(docs, null, 2) + '\n');
  });
}
