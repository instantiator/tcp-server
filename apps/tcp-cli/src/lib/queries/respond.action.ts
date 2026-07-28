import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

interface Conversation {
  slug: string;
  status: string;
}

/**
 * Posts a reply to an open agent query conversation, closing it
 * and triggering agent resume if the conversation was linked to a paused agent.
 *
 * stdout: `{ slug, status }` JSON on success.
 */
export function respondAction(
  opts: GlobalOptions,
  slug: string,
  message: string,
  cmdOpts: { identifier?: string },
): Promise<void> {
  return runCommand(async () => {
    process.stderr.write('Sending response...\n');
    const token = await resolveToken({ ...opts, baseUrl: opts.tcpServer });
    const api = apiOptions(opts, token);

    const result = await apiRequest<Conversation>(
      api,
      'POST',
      `/api/conversation/${slug}/reply`,
      { content: message, authorIdentifier: cmdOpts.identifier },
    );

    process.stderr.write('Agent resumed.\n');
    process.stdout.write(
      JSON.stringify({ slug: result.slug, status: result.status }, null, 2) +
        '\n',
    );
  });
}
