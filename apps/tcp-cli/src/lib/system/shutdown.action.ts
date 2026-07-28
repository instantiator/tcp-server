import { GlobalOptions } from '../core/cli-options';
import { runCommand } from '../core/run-command';
import { resolveSession, TokenManager } from '../auth/token';

/** How far a drain has got, as reported by `GET /api/system/shutdown`. */
export interface ShutdownStatus {
  state: 'idle' | 'draining' | 'quiesced';
  forced: boolean;
  agentsRunning: number;
}

export interface ShutdownOptions {
  /** Abort in-flight LLM calls instead of letting them finish. */
  force?: boolean;
  /** Drain only — leave the containers running for the caller to stop. */
  noStop?: boolean;
  /** Seconds to wait for quiescence before giving up. */
  timeout: number;
}

/** How long to leave between progress polls. */
const POLL_INTERVAL_MS = 1000;

/**
 * Drains the system for shutdown, reporting progress until it has quiesced.
 *
 * Halting is deliberately not done here: every Compose service is
 * `restart: unless-stopped`, so stopping containers is the host wrapper's job
 * (`tcp-cli.sh` runs `docker compose stop` once this exits 0). This action
 * owns the part that needs the API — knowing when it is actually safe to stop.
 *
 * Exits non-zero on timeout, having reported what is still running. It never
 * escalates to `--force` on its own: throwing away part-paid-for LLM calls is
 * the operator's decision, not a fallback.
 *
 * stdout: the final {@link ShutdownStatus} as JSON, so `tcp-cli.sh` (or any
 * other caller) can act on it. Progress goes to stderr.
 */
export function shutdownAction(
  opts: GlobalOptions,
  cmdOpts: ShutdownOptions,
): Promise<void> {
  return runCommand(async () => {
    const session = await resolveSession({ ...opts, baseUrl: opts.tcpServer });
    // A graceful drain waits on however long the slowest LLM call takes, which
    // can outlive an access token — so refresh in the background throughout.
    const tokens = new TokenManager(opts.tcpServer, session);

    try {
      const path = cmdOpts.force
        ? '/api/system/shutdown?force'
        : '/api/system/shutdown';
      let status = await tokens.request<ShutdownStatus>('POST', path);
      report(status, cmdOpts.force ?? false);

      const deadline = Date.now() + cmdOpts.timeout * 1000;
      while (status.state !== 'quiesced') {
        if (Date.now() >= deadline) {
          process.stderr.write(
            `Timed out after ${cmdOpts.timeout}s with ${status.agentsRunning} agent(s) still running.\n` +
              'The system is still draining and is refusing new work. Either wait longer, ' +
              'run `shutdown --force` to abort the in-flight LLM calls (wasting the tokens ' +
              'already spent on them), or cancel with `DELETE /api/system/shutdown`.\n',
          );
          process.stdout.write(JSON.stringify(status, null, 2) + '\n');
          process.exit(1);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        status = await tokens.request<ShutdownStatus>(
          'GET',
          '/api/system/shutdown',
        );
        report(status, cmdOpts.force ?? false);
      }

      process.stderr.write(
        cmdOpts.noStop
          ? 'System drained. Containers left running (--no-stop).\n'
          : 'System drained — safe to stop.\n',
      );
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    } finally {
      tokens.stop();
    }
  });
}

/**
 * Writes one progress line to stderr.
 *
 * A graceful drain can legitimately take minutes while an LLM finishes its
 * answer, so the operator needs to see it working rather than a silent hang.
 */
function report(status: ShutdownStatus, forced: boolean): void {
  const mode = status.forced || forced ? 'forced' : 'graceful';
  process.stderr.write(
    `Shutdown (${mode}): ${status.state}, ${status.agentsRunning} agent(s) still running\n`,
  );
}
