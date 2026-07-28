import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { addCompanyOptions, addRoleOptions } from '../lib/core/entity-ref';
import { storeKnowledgeAction } from '../lib/docs/store-knowledge.action';

/**
 * Uploads (or overwrites) a single document into a role's knowledge base, or
 * a company's shared knowledge. The server converts it to OKF Markdown.
 */
export function registerStoreKnowledge(program: Command): void {
  const cmd = program
    .command('store-knowledge')
    .description(
      'Upload a document (.md, .txt, .html, .pdf, .docx, .csv, .json, .yaml) to a role or company (shared knowledge) knowledge base',
    );
  addRoleOptions(cmd);
  addCompanyOptions(cmd);
  cmd
    .requiredOption('-s, --source <path>', 'Local file path to upload')
    .option(
      '-t, --target <filename>',
      'Filename to store as (defaults to the source filename)',
    )
    .action(
      (cmdOpts: {
        role?: string;
        roleId?: string;
        roleSlug?: string;
        company?: string;
        companyId?: string;
        companySlug?: string;
        source: string;
        target?: string;
      }) => storeKnowledgeAction(getGlobalOptions(program), cmdOpts),
    );
}
