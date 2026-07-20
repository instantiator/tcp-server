import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions } from '../lib/core/entity-ref';
import { reindexKnowledgeAction } from '../lib/docs/reindex-knowledge.action';

/**
 * Rebuilds the RAG index for every knowledge scope of a company (shared plus
 * each role). Useful after editing knowledge files directly in the object
 * store, before the reconciliation poller would catch them.
 */
export function registerReindexKnowledge(program: Command): void {
  const cmd = program
    .command('reindex-knowledge')
    .description(
      "Rebuild the RAG index for all of a company's knowledge (shared + every role)",
    );
  addCompanyOptions(cmd, { required: true });
  cmd.action(
    (cmdOpts: { company?: string; companyId?: string; companySlug?: string }) =>
      reindexKnowledgeAction(getGlobalOptions(program), cmdOpts),
  );
}
