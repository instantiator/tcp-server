import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { shutdownAction } from '../lib/system/shutdown.action';

/** Default seconds to wait for a graceful drain — generous enough for a slow local model to finish a turn. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/**
 * Drains the system for shutdown, then reports that it is safe to halt.
 *
 * Stopping the containers is done by `tcp-cli.sh` once this exits 0 — see
 * {@link shutdownAction} for why halting cannot live in the Node CLI.
 */
export function registerShutdown(program: Command): void {
  program
    .command('shutdown')
    .description('Drain the system for shutdown, waiting for agents to pause')
    .option(
      '-f, --force',
      'Abort in-flight LLM calls immediately, wasting the tokens already spent on them',
    )
    .option('--no-stop', 'Drain only; leave the containers running')
    .option(
      '--timeout <seconds>',
      'Give up waiting after this many seconds and exit non-zero',
      (value: string) => Number.parseInt(value, 10),
      DEFAULT_TIMEOUT_SECONDS,
    )
    .action((cmdOpts: { force?: boolean; stop: boolean; timeout: number }) =>
      shutdownAction(getGlobalOptions(program), {
        force: cmdOpts.force,
        // Commander maps `--no-stop` to `stop: false`.
        noStop: !cmdOpts.stop,
        timeout: cmdOpts.timeout,
      }),
    );
}
