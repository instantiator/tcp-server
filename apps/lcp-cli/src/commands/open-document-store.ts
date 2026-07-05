import { Command } from 'commander';
import { openDocumentStoreAction } from '../lib/links/open-document-store.action';

/** Registers the `open-document-store` command. */
export function registerOpenDocumentStore(program: Command): void {
  program
    .command('open-document-store')
    .description('Print (and optionally open) the MinIO document store console')
    .option('--no-open', 'Print the URL without opening the browser')
    .action((cmdOpts: { open: boolean }) => openDocumentStoreAction(cmdOpts));
}
