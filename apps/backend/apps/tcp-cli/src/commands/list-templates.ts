import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { listTemplatesAction } from '../lib/templates/template-gallery.action';

/** Registers the `list-templates` command. */
export function registerListTemplates(program: Command): void {
  program
    .command('list-templates')
    .description('List the templates in the gallery')
    .action(() => listTemplatesAction(getGlobalOptions(program)));
}
