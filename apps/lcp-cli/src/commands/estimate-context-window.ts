import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import {
  estimateContextWindowAction,
  EstimateContextWindowOpts,
} from '../lib/context/estimate-context-window.action';

/** Registers the `estimate-context-window` command. */
export function registerEstimateContextWindow(program: Command): void {
  program
    .command('estimate-context-window')
    .description(
      "Estimate a role's worst-case initial-prompt token footprint against its LLM's context window",
    )
    .option('-c, --company-id <uuid>', 'Company UUID')
    .option('--company-slug <slug>', 'Company slug, instead of --company-id')
    .option('-r, --role-id <uuid>', 'Role UUID')
    .option(
      '--role-slug <slug>',
      'Role slug, instead of --role-id (requires --company-id or --company-slug)',
    )
    .option(
      '--from-file <path>',
      'Read {"company":...,"role":...} from a JSON file instead of a live server',
    )
    .option(
      '--query <text>',
      'Actual task query text to size (counted exactly)',
    )
    .option(
      '--query-tokens <n>',
      'Estimated task query size in tokens, when --query is not given (default: 200)',
      Number,
    )
    .option(
      '--rag-tokens <n>',
      'Estimated RAG retrieval size in tokens (default: worst case, 5 chunks x 2000 chars)',
      Number,
    )
    .option(
      '--turn-tokens <n>',
      'Estimated tokens per further conversation turn (default: 300)',
      Number,
    )
    .option(
      '-n, --turns <n>',
      'Number of further turns to project (default: 20)',
      Number,
    )
    .option(
      '--json',
      'Print the full breakdown as JSON instead of just the total',
    )
    .action((cmdOpts: EstimateContextWindowOpts) =>
      estimateContextWindowAction(getGlobalOptions(program), cmdOpts),
    );
}
