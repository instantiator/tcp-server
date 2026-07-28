import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { AuditRow, toWire } from '../render/audit-wire';
import { EventLogBuffer } from '../render/event-log';
import { StreamPresenter } from '../render/stream-presenter';
import { ansiStyle, plainStyle } from '../render/style';
import { resolveSession, TokenManager } from '../auth/token';
import { headingProvider, resolveTarget, TargetRef } from './eavesdrop-target';
import { tailTarget } from './eavesdrop-tail';

export interface EavesdropCmdOpts extends TargetRef {
  showHistory?: boolean;
  tail?: boolean;
}

/**
 * Eavesdrops on an agent, assignment, or task (exactly one of `--agent-id`,
 * `--assignment-id`, `--task-id`): reconstructs its history from the audit log
 * (`--show-history`) and/or follows it live (`--tail`).
 *
 * `--show-history` prints every recorded event to stdout, oldest first, grouped
 * under a heading block whenever the active agent changes.
 *
 * `--tail` follows the target's working agent(s) via their SSE event streams,
 * rendered the same way `chat` renders its own agent's stream. It warns and
 * exits (non-zero) if the target has already finished — or, for
 * `--assignment-id`, hasn't started.
 */
export function eavesdropAction(
  opts: GlobalOptions,
  cmdOpts: EavesdropCmdOpts,
): Promise<void> {
  return runCommand(async () => {
    const targetsGiven = [
      cmdOpts.agentId,
      cmdOpts.assignmentId,
      cmdOpts.taskId,
    ].filter(Boolean).length;
    if (targetsGiven !== 1) {
      process.stderr.write(
        'Error: pass exactly one of --agent-id, --assignment-id, --task-id\n',
      );
      process.exit(1);
      return;
    }
    if (!cmdOpts.showHistory && !cmdOpts.tail) {
      process.stderr.write('Error: pass --show-history and/or --tail\n');
      process.exit(1);
      return;
    }

    const session = await resolveSession({ ...opts, baseUrl: opts.tcpServer });
    const tokenManager = new TokenManager(opts.tcpServer, session);
    const api = apiOptions(opts, tokenManager.current);
    const target = await resolveTarget(api, cmdOpts);
    const agentsById = new Map(target.agents.map((a) => [a.agentId, a]));

    // One buffer + presenter for the whole session: `--show-history` and
    // `--tail` feed the same pipeline, so history and live are one stream.
    // Everything goes to stdout (coloured only when it's a TTY).
    const buffer = new EventLogBuffer(headingProvider(agentsById));
    new StreamPresenter(buffer, {
      out: process.stdout,
      err: process.stdout,
      style: process.stdout.isTTY ? ansiStyle : plainStyle,
    });

    if (cmdOpts.showHistory) {
      const rows = target.historyPath
        ? await apiRequest<AuditRow[]>(api, 'GET', target.historyPath)
        : [];
      for (const row of rows) buffer.appendAudit(toWire(row));
    }

    if (cmdOpts.tail) {
      if (target.terminal || target.agents.length === 0) {
        process.stderr.write(
          'Warning: nothing to tail — the target has already finished (or has not started)\n',
        );
        process.exit(1);
        return;
      }
      await tailTarget(opts, tokenManager, target, buffer, agentsById);
    }
    tokenManager.stop();
  });
}
