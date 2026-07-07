import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { storeRoleDocumentsAction } from '../lib/docs/store-role-documents.action';

/**
 * Uploads OKF Markdown documents to a role's knowledge base.
 *
 * Files are validated first (`.md` extension + front-matter with `title`).
 * If any file fails validation, none are uploaded.
 *
 * stdout: JSON array of `{ key, name, size, lastModified }` for each
 * successfully uploaded document.
 */
export function registerStoreRoleDocuments(program: Command): void {
  program
    .command('store-role-documents')
    .description('Upload OKF Markdown documents to a role knowledge base')
    .option('-r, --role-id <uuid>', 'Role UUID')
    .option(
      '--role-slug <slug>',
      'Role slug instead of ID (requires --company-id or --company-slug)',
    )
    .option('-c, --company-id <uuid>', 'Company UUID (for --role-slug)')
    .option('--company-slug <slug>', 'Company slug (for --role-slug)')
    .requiredOption(
      '-s, --src <paths...>',
      'One or more Markdown file paths to upload',
    )
    .action(
      (cmdOpts: {
        roleId?: string;
        roleSlug?: string;
        companyId?: string;
        companySlug?: string;
        src: string[];
      }) => storeRoleDocumentsAction(getGlobalOptions(program), cmdOpts),
    );
}
