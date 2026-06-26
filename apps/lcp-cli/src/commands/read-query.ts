import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

interface Conversation {
  slug: string;
  roleName: string;
  question: string;
  context?: string;
  status: string;
  createdAt: string;
  closedAt?: string;
}

interface ConversationMessage {
  author: string;
  authorIdentifier?: string;
  content: string;
  timestamp: string;
}

/**
 * Displays the full content of a single agent query conversation,
 * including any prior messages.
 *
 * stdout: formatted text output.
 */
export function registerReadQuery(program: Command): void {
  program
    .command('read-query <slug>')
    .description('Show the full question, context, and messages for a query')
    .action(async (slug: string) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();
      try {
        const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
        const api = { baseUrl: opts.lcpServer, token };

        const { conversation, messages } = await apiRequest<{
          conversation: Conversation;
          messages: ConversationMessage[];
        }>(api, 'GET', `/api/conversation/${slug}`);

        const lines: string[] = [
          `Slug:   ${conversation.slug}`,
          `Role:   ${conversation.roleName}`,
          `Status: ${conversation.status}`,
          `Date:   ${new Date(conversation.createdAt).toLocaleString()}`,
          '',
          '--- Question ---',
          conversation.question,
        ];

        if (conversation.context) {
          lines.push('', '--- Context ---', conversation.context);
        }

        if (messages.length > 0) {
          lines.push('', '--- Messages ---');
          for (const m of messages) {
            const who = m.authorIdentifier
              ? `${m.author} (${m.authorIdentifier})`
              : m.author;
            lines.push(`[${new Date(m.timestamp).toLocaleString()}] ${who}:`);
            lines.push(m.content);
            lines.push('');
          }
        }

        process.stdout.write(lines.join('\n') + '\n');
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }
    });
}
