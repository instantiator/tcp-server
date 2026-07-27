import { Command } from 'commander';
import {
  openSwaggerAction,
  SWAGGER_SERVICES,
} from '../lib/links/open-swagger.action';

/** Registers the `open-swagger` command. */
export function registerOpenSwagger(program: Command): void {
  program
    .command('open-swagger')
    .description(
      'Print (and optionally open) the Swagger UI for an TCP service',
    )
    .requiredOption(
      '--service <name>',
      `Service to open (${SWAGGER_SERVICES.join(' | ')})`,
    )
    .option('--no-open', 'Print the URL without opening the browser')
    .action((cmdOpts: { service: string; open: boolean }) =>
      openSwaggerAction(cmdOpts),
    );
}
