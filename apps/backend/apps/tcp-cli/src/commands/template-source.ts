import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import {
  addTemplateSourceAction,
  listTemplateSourcesAction,
  removeTemplateSourceAction,
} from '../lib/templates/template-gallery.action';

/** Registers `template-source` and its `list`, `add` and `remove` subcommands. */
export function registerTemplateSource(program: Command): void {
  const cmd = program
    .command('template-source')
    .description('Manage where the template gallery reads templates from');
  cmd
    .command('list')
    .description('List the gallery sources')
    .action(() => listTemplateSourcesAction(getGlobalOptions(program)));
  cmd
    .command('add <name> <repo>')
    .description('Add a public GitHub repository (owner/repo); admin only')
    .option('--ref <ref>', 'Branch or tag (default: main)')
    .option('--path <path>', 'Folder holding the templates (default: the root)')
    .action(
      (name: string, repo: string, cmdOpts: { ref?: string; path?: string }) =>
        addTemplateSourceAction(getGlobalOptions(program), name, repo, cmdOpts),
    );
  cmd
    .command('remove <id>')
    .description('Remove a source added with add; admin only')
    .action((id: string) =>
      removeTemplateSourceAction(getGlobalOptions(program), id),
    );
}
