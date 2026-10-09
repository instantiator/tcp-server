import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveSession, resolveToken, TokenManager } from '../auth/token';

/** How far a drain has got, as reported by `GET /api/system/shutdown`. */
export interface ShutdownStatus {
  state: 'idle' | 'draining' | 'quiesced';
  forced: boolean;
  agentsRunning: number;
  /** The drain ends in a restart rather than a halt. */
  restart: boolean;
  /** Whether this deployment can restart itself (Docker brings the services back). */
  restartSupported: boolean;
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
              'already spent on them), or cancel with `cancel-shutdown`.\n',
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
function report(
  status: ShutdownStatus,
  forced: boolean,
  label = 'Shutdown',
): void {
  const mode = status.forced || forced ? 'forced' : 'graceful';
  process.stderr.write(
    `${label} (${mode}): ${status.state}, ${status.agentsRunning} agent(s) still running\n`,
  );
}

/** Cancels a shutdown or restart in progress, so the system takes work again. stdout: the {@link ShutdownStatus}. */
export function cancelShutdownAction(opts: GlobalOptions): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const status = await apiRequest<ShutdownStatus>(
      apiOptions(opts, token),
      'DELETE',
      '/api/system/shutdown',
    );
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  });
}

/**
 * Drains the system, then waits for tcp-server and tcp-agent to exit and come
 * back (Docker restarts them), so paused work carries on by itself.
 *
 * Once drained, reads of the status may still succeed before the process
 * exits, or fail while it is down. The restart only counts as finished when
 * an `idle` answer arrives after a failed read or after the state has left
 * `quiesced` — a read taken before the exit must not end the wait early.
 *
 * Exits non-zero if the whole wait outlasts `timeout`. stdout: the final
 * {@link ShutdownStatus}; progress goes to stderr.
 */
export function restartAction(
  opts: GlobalOptions,
  cmdOpts: Omit<ShutdownOptions, 'noStop'>,
): Promise<void> {
  return runCommand(async () => {
    const session = await resolveSession({ ...opts, baseUrl: opts.tcpServer });
    const tokens = new TokenManager(opts.tcpServer, session);

    try {
      const forced = cmdOpts.force ?? false;
      let status = await tokens.request<ShutdownStatus>(
        'POST',
        forced
          ? '/api/system/shutdown?restart&force'
          : '/api/system/shutdown?restart',
      );
      report(status, forced, 'Restart');

      const deadline = Date.now() + cmdOpts.timeout * 1000;
      let quiesced = false;
      let left = false;
      let back = false;
      while (!back) {
        if (Date.now() >= deadline) {
          process.stderr.write(
            `Timed out after ${cmdOpts.timeout}s waiting for the restart to finish.\n`,
          );
          process.stdout.write(JSON.stringify(status, null, 2) + '\n');
          process.exit(1);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          status = await tokens.request<ShutdownStatus>(
            'GET',
            '/api/system/shutdown',
          );
          if (!quiesced) {
            report(status, forced, 'Restart');
          } else if (status.state === 'idle' && left) {
            back = true;
          } else if (status.state !== 'quiesced') {
            left = true;
          }
        } catch {
          // The services are down: exactly what a restart looks like.
          if (quiesced) left = true;
        }
        if (!quiesced && status.state === 'quiesced') {
          quiesced = true;
          process.stderr.write('Restarting the services…\n');
        }
      }

      process.stderr.write(
        'Restarted — the services are back, and paused work carries on by itself.\n',
      );
      process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    } finally {
      tokens.stop();
    }
  });
}
