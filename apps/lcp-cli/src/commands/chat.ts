import * as readline from 'readline';
import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveSession, renewToken } from '../lib/auth';

interface AgentRecord {
  id: string;
}

interface MessageResponse {
  response: string;
}

/**
 * Initiates a conversation with an agent running the specified role.
 *
 * Single-query mode (-q): creates agent, sends one message, prints response, deletes agent.
 * Interactive mode: enters a readline loop; the agent is deleted on exit or Ctrl+C.
 *
 * Conversation history is maintained server-side in the LangGraph checkpoint store
 * (keyed by the agent's thread_id = agent.id), so context carries across turns.
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
        process.stderr.write(`LLM API: ${llmConfig.baseUrl ?? '(provider default)'}\n`);
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

      /** Sends one message and returns the agent's reply, refreshing the token on 401. */
      const sendMessage = async (message: string): Promise<string> => {
        const doRequest = () =>
          apiRequest<MessageResponse>(
            { baseUrl: opts.lcpServer, token },
            'POST',
            `/api/agent/${agentId}/message`,
            { message },
          );
        try {
          return (await doRequest()).response;
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes('HTTP 401') &&
            refreshToken
          ) {
            token = await renewToken(opts.lcpServer, refreshToken);
            return (await doRequest()).response;
          }
          throw err;
        }
      };

      if (cmdOpts.query) {
        // Single-query mode
        try {
          process.stderr.write('Sending...\n');
          const response = await sendMessage(cmdOpts.query);
          process.stdout.write(response + '\n');
        } catch (err) {
          process.stderr.write(
            `Error: ${String(err instanceof Error ? err.message : err)}\n`,
          );
        } finally {
          await cleanup();
        }
        return;
      }

      // Interactive mode
      process.on('SIGINT', () => {
        void cleanup().then(() => process.exit(0));
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
        try {
          process.stderr.write('Thinking... (Ctrl+C to cancel)\n');
          const response = await sendMessage(trimmed);
          process.stdout.write(response + '\n');
        } catch (err) {
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
