import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

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
export function registerRespond(program: Command): void {
  program
    .command('respond <slug> <message>')
    .description(
      'Reply to an open agent query (closes the conversation and resumes the agent)',
    )
    .option(
      '-i, --identifier <id>',
      'Your identifier (e.g. email), included in the message record',
    )
    .action(
      async (
        slug: string,
        message: string,
        cmdOpts: { identifier?: string },
      ) => {
        const opts = program.opts<{
          lcpServer: string;
          accessToken?: string;
          accessTokenEnvVar?: string;
          username?: string;
          password?: string;
        }>();
        try {
          process.stderr.write('Sending response...\n');
          const token = await resolveToken({
            ...opts,
            baseUrl: opts.lcpServer,
          });
          const api = { baseUrl: opts.lcpServer, token };

          const result = await apiRequest<Conversation>(
            api,
            'POST',
            `/api/conversation/${slug}/reply`,
            { content: message, authorIdentifier: cmdOpts.identifier },
          );

          process.stderr.write('Agent resumed.\n');
          process.stdout.write(
            JSON.stringify(
              { slug: result.slug, status: result.status },
              null,
              2,
            ) + '\n',
          );
        } catch (err) {
          process.stderr.write(
            `Error: ${String(err instanceof Error ? err.message : err)}\n`,
          );
          process.exit(1);
        }
      },
    );
}
