import { Command } from 'commander';
import { getGlobalOptions } from '../lib/core/cli-options';
import { restartAction } from '../lib/system/shutdown.action';

/** Default seconds to wait for the drain and the restart together. */
const DEFAULT_TIMEOUT_SECONDS = 600;

/** Drains the system, then restarts tcp-server and tcp-agent. */
export function registerRestart(program: Command): void {
  program
    .command('restart')
    .description(
      'Drain the system, then restart tcp-server and tcp-agent; paused work carries on by itself',
    )
    .option(
      '-f, --force',
      'Abort in-flight LLM calls immediately, wasting the tokens already spent on them',
    )
    .option(
      '--timeout <seconds>',
      'Give up waiting after this many seconds and exit non-zero',
      (value: string) => Number.parseInt(value, 10),
      DEFAULT_TIMEOUT_SECONDS,
    )
    .action((cmdOpts: { force?: boolean; timeout: number }) =>
      restartAction(getGlobalOptions(program), cmdOpts),
    );
}
