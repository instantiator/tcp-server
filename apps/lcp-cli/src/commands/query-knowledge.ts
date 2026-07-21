import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { queryKnowledgeAction } from '../lib/docs/query-knowledge.action';

/**
 * Runs a RAG similarity search for a role, printing the raw chunks that
 * would be injected into a prompt — without invoking any chat/LLM call.
 */
export function registerQueryKnowledge(program: Command): void {
  const cmd = program
    .command('query-knowledge')
    .description(
      'Query the RAG index for a role, without invoking any LLM call',
    );
  addRoleOptions(cmd, { required: true });
  addCompanyOptions(cmd);
  cmd
    .requiredOption('-q, --query <text>', 'Query text')
    .option('--top-k <n>', 'Maximum chunks to return (default 5)')
    .option(
      '--threshold <n>',
      'Minimum cosine similarity to include (default 0.7)',
    )
    .action(
      (cmdOpts: {
        role?: string;
        roleId?: string;
        roleSlug?: string;
        company?: string;
        companyId?: string;
        companySlug?: string;
        query: string;
        topK?: string;
        threshold?: string;
      }) => queryKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
