import { Command } from 'commander';
import * as readline from 'readline';
import { apiRequest } from '../lib/api';
import { renewToken, resolveSession } from '../lib/auth';

interface AgentRecord {
  id: string;
}

interface MessageResponse {
  response: string;
  compactionReport?: CompactionReport;
}

/**
 * Compaction report included in a {@link MessageResponse} when the server
 * trimmed or summarised context to fit within the model's context window.
 */
interface CompactionReport {
  strategies: string[];
  activities: string[];
  duration: number;
  before: { tokens: number; windowSize: number; pct: number };
  after: { tokens: number; windowSize: number; pct: number };
}

/**
 * Initiates a conversation with an agent running the specified role.
 *
 * Single-query mode (-q): creates agent, sends one message, prints response, deletes agent.
 * Interactive mode: enters a readline loop; the agent is deleted on exit or Ctrl+C.
 *
 * Conversation history is maintained server-side in the LangGraph checkpoint store
 * (keyed by the agent's thread_id = agent.id), so context carries across turns.
 *
 * Ctrl+C behaviour in interactive mode:
 * - While waiting for a response: cancels the in-flight request and re-shows the prompt.
 * - When idle (at the prompt): cleans up the agent and exits.
 */
export function registerChat(program: Command): void {
  program
    .command('chat')
    .description('Start an interactive chat session with an agent')
    .requiredOption('-r, --role-id <uuid>', 'Role UUID for the agent')
    .option('-q, --query <message>', 'Single query (non-interactive)')
    .action(async (cmdOpts: { roleId: string; query?: string }) => {
      const opts = program.opts<{
        lcpServer: string;
        accessToken?: string;
        refreshToken?: string;
        accessTokenEnvVar?: string;
        username?: string;
        password?: string;
      }>();

      let agentId: string | undefined;

      const cleanup = async () => {
        if (agentId) {
          try {
            await apiRequest(
              { baseUrl: opts.lcpServer, token },
              'DELETE',
              `/api/agent/${agentId}`,
            );
            process.stderr.write(`\nAgent ${agentId} removed.\n`);
          } catch {
            // best-effort cleanup
          }
          agentId = undefined;
        }
      };

      let token: string;
      let refreshToken: string | undefined;
      try {
        ({ token, refreshToken } = await resolveSession({
          ...opts,
          baseUrl: opts.lcpServer,
        }));

        // We need the company ID to start a chat — resolve it from the role
        type LlmConfig = { provider: string; model: string; baseUrl?: string };
        const role = await apiRequest<{
          id: string;
          companyId: string;
          name: string;
          llmConfig?: LlmConfig | null;
        }>(
          { baseUrl: opts.lcpServer, token },
          'GET',
          `/api/role/${cmdOpts.roleId}`,
        );

        // Mirror the agent's resolution: role.llmConfig → company.llmDefault → error
        let llmConfig = role.llmConfig;
        if (!llmConfig) {
          const company = await apiRequest<{ llmDefault?: LlmConfig | null }>(
            { baseUrl: opts.lcpServer, token },
            'GET',
            `/api/company/${role.companyId}`,
          );
          llmConfig = company.llmDefault ?? null;
        }
        if (!llmConfig) {
          process.stderr.write(
            `Error: role has no llmConfig and company has no llmDefault\n`,
          );
          process.exit(1);
        }

        const agent = await apiRequest<AgentRecord>(
          { baseUrl: opts.lcpServer, token },
          'POST',
          '/api/agent/chat/start',
          { companyId: role.companyId, roleId: cmdOpts.roleId },
        );
        agentId = agent.id;
        process.stderr.write(`LCP API: ${opts.lcpServer}\n`);
        process.stderr.write(
          `LLM API: ${llmConfig.baseUrl ?? '(provider default)'}\n`,
        );
        process.stderr.write(`Provider: ${llmConfig.provider}\n`);
        process.stderr.write(`Model: ${llmConfig.model}\n`);
        process.stderr.write(`Role: ${role.name}\n`);
        process.stderr.write(`'exit', 'quit', or Ctrl+C to exit.\n`);
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }

      /**
       * Active abort controller for the in-flight LLM request.
       * Null when no request is in progress.
       */
      let currentAbort: AbortController | null = null;

      /**
       * Sends one message and returns the agent's reply (or null if cancelled),
       * refreshing the token on 401.
       */
      const sendMessage = async (
        message: string,
      ): Promise<MessageResponse | null> => {
        currentAbort = new AbortController();
        const doRequest = () =>
          apiRequest<MessageResponse>(
            { baseUrl: opts.lcpServer, token, signal: currentAbort!.signal },
            'POST',
            `/api/agent/${agentId}/message`,
            { message },
          );
        try {
          const result = await doRequest();
          return result;
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return null;
          if (
            err instanceof Error &&
            err.message.includes('HTTP 401') &&
            refreshToken
          ) {
            token = await renewToken(opts.lcpServer, refreshToken);
            const result = await doRequest();
            return result;
          }
          throw err;
        } finally {
          currentAbort = null;
        }
      };

      /** Opens an SSE stream to display compaction progress if the request takes > 3 s. */
      const observeEvents = (id: string, stopSignal: AbortSignal): void => {
        const url = `${opts.lcpServer.replace(/\/$/, '')}/api/agent/${id}/events`;
        void (async () => {
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${token}` },
              signal: stopSignal,
            });
            if (!res.ok || !res.body) return;
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              // SSE lines end with \n\n
              const parts = buffer.split('\n\n');
              buffer = parts.pop() ?? '';
              for (const part of parts) {
                const dataLine = part
                  .split('\n')
                  .find((l) => l.startsWith('data:'));
                if (!dataLine) continue;
                try {
                  const event = JSON.parse(dataLine.slice(5).trim()) as {
                    kind: string;
                    data?: Record<string, unknown>;
                  };
                  if (event.kind === 'compaction_started') {
                    const d = event.data ?? {};
                    const strats = Array.isArray(d.strategies)
                      ? (d.strategies as string[]).join(', ')
                      : '';
                    const tb =
                      typeof d.tokensBefore === 'number' ? d.tokensBefore : '?';
                    const ws =
                      typeof d.windowSize === 'number' ? d.windowSize : '?';
                    const pct = typeof d.pct === 'number' ? d.pct : '?';
                    process.stderr.write(
                      `[Context compacting: strategies=[${strats}], ${tb}/${ws} tokens (${pct}%)]\n`,
                    );
                  } else if (event.kind === 'compaction_complete') {
                    const d = event.data ?? {};
                    const ta =
                      typeof d.tokensAfter === 'number' ? d.tokensAfter : '?';
                    const ws =
                      typeof d.windowSize === 'number' ? d.windowSize : '?';
                    const pa =
                      typeof d.pctAfter === 'number' ? d.pctAfter : '?';
                    process.stderr.write(
                      `[Context compacted: ${ta}/${ws} tokens (${pa}%)]\n`,
                    );
                  }
                } catch {
                  // ignore malformed SSE events
                }
              }
            }
          } catch {
            // SSE stream closed or aborted — expected on cleanup
          }
        })();
      };

      /** Formats and prints a {@link CompactionReport} to stderr. */
      const printCompactionReport = (report: CompactionReport): void => {
        process.stderr.write(
          `[Compaction: ${report.strategies.join(', ')} | ` +
            `${report.before.tokens}→${report.after.tokens} tokens ` +
            `(${report.before.pct}%→${report.after.pct}% of ${report.before.windowSize}) | ` +
            `${report.duration}ms]\n`,
        );
        for (const activity of report.activities) {
          process.stderr.write(`  · ${activity}\n`);
        }
      };

      if (cmdOpts.query) {
        // Single-query mode
        try {
          process.stderr.write('Sending...\n');
          const result = await sendMessage(cmdOpts.query);
          if (result) {
            process.stdout.write(result.response + '\n');
            if (result.compactionReport)
              printCompactionReport(result.compactionReport);
          }
        } catch (err) {
          process.stderr.write(
            `Error: ${String(err instanceof Error ? err.message : err)}\n`,
          );
        } finally {
          await cleanup();
        }
        return;
      }

      // Interactive mode — two-stage SIGINT:
      //   First Ctrl+C while waiting: cancel in-flight request, re-show prompt.
      //   Ctrl+C when idle (or second in quick succession): cleanup and exit.
      process.on('SIGINT', () => {
        if (currentAbort) {
          currentAbort.abort();
          process.stderr.write('\nCancelled.\n');
        } else {
          void cleanup().then(() => process.exit(0));
        }
      });

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
        terminal: true,
        prompt: '> ',
      });

      const prompt = () => rl.prompt();
      prompt();

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') break;

        // Start SSE observer after EVENT_TIMEOUT_MS if no response yet
        const EVENT_TIMEOUT_MS = 3000;
        const sseAbort = new AbortController();
        const sseTimer = setTimeout(() => {
          if (agentId) observeEvents(agentId, sseAbort.signal);
        }, EVENT_TIMEOUT_MS);

        try {
          process.stderr.write('Thinking... (Ctrl+C to cancel)\n');
          const result = await sendMessage(trimmed);
          clearTimeout(sseTimer);
          sseAbort.abort();
          if (result === null) {
            // cancelled by user — re-prompt without printing an error
          } else {
            process.stdout.write(result.response + '\n');
            if (result.compactionReport)
              printCompactionReport(result.compactionReport);
          }
        } catch (err) {
          clearTimeout(sseTimer);
          sseAbort.abort();
          process.stderr.write(
            `Error: ${String(err instanceof Error ? err.message : err)}\n`,
          );
        }
        prompt();
      }

      rl.close();
      await cleanup();
    });
}
