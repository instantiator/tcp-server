import { apiOptions, GlobalOptions } from '../core/cli-options';
import { apiRequest } from '../core/api';
import { runCommand } from '../core/run-command';
import { resolveToken } from '../auth/token';

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

/** Builds the formatted text report for a conversation and its messages. */
function formatConversation(
  conversation: Conversation,
  messages: ConversationMessage[],
): string {
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

  return lines.join('\n') + '\n';
}

/**
 * Displays the full content of a single agent query conversation,
 * including any prior messages.
 *
 * stdout: formatted text output.
 */
export function readQueryAction(
  opts: GlobalOptions,
  slug: string,
): Promise<void> {
  return runCommand(async () => {
    const token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });
    const api = apiOptions(opts, token);

    const { conversation, messages } = await apiRequest<{
      conversation: Conversation;
      messages: ConversationMessage[];
    }>(api, 'GET', `/api/conversation/${slug}`);

    process.stdout.write(formatConversation(conversation, messages));
  });
}
