import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { newTemplateAction } from '../lib/templates/new-template.action';

/** Registers the `new-template` command. */
export function registerNewTemplate(program: Command): void {
  program
    .command('new-template <dir>')
    .description(
      'Start a template: unpack the blank one, with its format reference, into a new directory',
    )
    .action((dir: string) => newTemplateAction(getGlobalOptions(program), dir));
}
