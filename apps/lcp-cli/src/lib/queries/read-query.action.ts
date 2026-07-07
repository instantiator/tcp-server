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

/** Formats a UTC timestamp string for display, localized to `timezone` when set. */
function formatTimestamp(timestamp: string, timezone: string | null): string {
  return new Date(timestamp).toLocaleString(
    'en-US',
    timezone ? { timeZone: timezone } : undefined,
  );
}

/** Builds the formatted text report for a conversation and its messages. */
export function formatConversation(
  conversation: Conversation,
  messages: ConversationMessage[],
  companyTimezone: string | null,
): string {
  const lines: string[] = [
    `Slug:   ${conversation.slug}`,
    `Role:   ${conversation.roleName}`,
    `Status: ${conversation.status}`,
    `Date:   ${formatTimestamp(conversation.createdAt, companyTimezone)}`,
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
      lines.push(`[${formatTimestamp(m.timestamp, companyTimezone)}] ${who}:`);
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

    const { conversation, messages, companyTimezone } = await apiRequest<{
      conversation: Conversation;
      messages: ConversationMessage[];
      companyTimezone: string | null;
    }>(api, 'GET', `/api/conversation/${slug}`);

    process.stdout.write(
      formatConversation(conversation, messages, companyTimezone),
    );
  });
}
