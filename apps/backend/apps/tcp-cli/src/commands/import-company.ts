import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import {
  importCompanyAction,
  ImportCompanyOpts,
} from '../lib/templates/import-company.action';

/** Registers the `import-company` command. */
export function registerImportCompany(program: Command): void {
  program
    .command('import-company [path]')
    .description(
      'Create a company from a template: a .zip, a template directory, or --template <sourceId/name>',
    )
    .option(
      '--template <sourceId/name>',
      'A gallery template, instead of a path',
    )
    .option('--slug <slug>', "The company's slug (default: the template's)")
    .option('--name <name>', "The company's name (default: the template's)")
    .option(
      '--llm-config <json>',
      "The company's model as JSON; the word null clears it",
    )
    .option(
      '--no-role-models',
      "Import roles without the template's own models",
    )
    .option('--replace', 'Replace an existing company with the same slug')
    .option('--preview', 'Print what would be created and import nothing')
    .action((source: string | undefined, cmdOpts: ImportCompanyOpts) =>
      importCompanyAction(getGlobalOptions(program), source, cmdOpts),
    );
}
