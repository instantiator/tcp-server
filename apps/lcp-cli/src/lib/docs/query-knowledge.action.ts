import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { EntityRefOpts, resolveRoleId } from '../core/entity-ref';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

/** A single chunk returned by the server's RAG similarity search. */
interface RagChunk {
  id: string;
  documentPath: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

/**
 * Runs a RAG similarity search for a role and prints the ranked chunks —
 * the same data prompt assembly would inject, without invoking any chat/LLM
 * call.
 *
 * stdout: JSON `RagChunk[]`, ranked by similarity descending.
 */
export function queryKnowledgeAction(
  opts: GlobalOptions,
  cmdOpts: EntityRefOpts & { query: string; topK?: string; threshold?: string },
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);
    const roleId = await resolveRoleId(api, cmdOpts);

    const qs = new URLSearchParams({ q: cmdOpts.query });
    if (cmdOpts.topK !== undefined) qs.set('topK', cmdOpts.topK);
    if (cmdOpts.threshold !== undefined) qs.set('threshold', cmdOpts.threshold);

    const chunks = await apiRequest<RagChunk[]>(
      api,
      'GET',
      `/api/role/${roleId}/knowledge/query?${qs.toString()}`,
    );
    process.stdout.write(JSON.stringify(chunks, null, 2) + '\n');
  });
}
