import * as readline from 'readline';
import { Command } from 'commander';
import { apiRequest } from '../lib/api';
import { resolveToken } from '../lib/auth';

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
      try {
        token = await resolveToken({ ...opts, baseUrl: opts.lcpServer });

        // We need the company ID to start a chat — resolve it from the role
        const role = await apiRequest<{ id: string; companyId: string }>(
          { baseUrl: opts.lcpServer, token },
          'GET',
          `/api/role/${cmdOpts.roleId}`,
        );

        const agent = await apiRequest<AgentRecord>(
          { baseUrl: opts.lcpServer, token },
          'POST',
          '/api/agent/chat/start',
          { companyId: role.companyId, roleId: cmdOpts.roleId },
        );
        agentId = agent.id;
        process.stderr.write(`Chat agent ${agentId} started.\n`);
      } catch (err) {
        process.stderr.write(
          `Error: ${String(err instanceof Error ? err.message : err)}\n`,
        );
        process.exit(1);
      }

      /** Sends one message and returns the agent's reply. */
      const sendMessage = async (message: string): Promise<string> => {
        const res = await apiRequest<MessageResponse>(
          { baseUrl: opts.lcpServer, token },
          'POST',
          `/api/agent/${agentId}/message`,
          { message },
        );
        return res.response;
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
      });

      const prompt = () => process.stderr.write('> ');
      prompt();

      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'exit' || trimmed === 'quit') break;
        try {
          process.stderr.write('Thinking...\n');
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
