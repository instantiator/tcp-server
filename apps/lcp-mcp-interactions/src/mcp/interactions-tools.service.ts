import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with stub interaction tools.
 * A new server is created per request so state is never shared across sessions.
 */
@Injectable()
export class InteractionsToolsService {
  /** Creates and returns a configured McpServer with all interaction tools registered. */
  createServer(): McpServer {
    const server = new McpServer({
      name: 'lcp-mcp-interactions',
      version: '1.0.0',
    });

    this.registerDescribeServer(server);
    this.registerRequestUserInput(server);
    this.registerRequestAgentConsultation(server);

    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.tool(
      'describe_server',
      'Returns an overview of the interactions service and its tools.',
      {},
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: [
                '## Interactions Service',
                '',
                'Enables requesting input from users or consultation from other agents.',
                'These tools pause agent execution until the requested input is received.',
                'This service is not yet fully implemented — tool calls return stub responses.',
                '',
                '### Tools',
                '- **describe_server** — this overview',
                '- **request_user_input(question, context?)** — pause and request input from a human user (stub)',
                '- **request_agent_consultation(role_name, question, context?)** — consult another agent by role (stub)',
              ].join('\n'),
            },
          ],
        };
      },
    );
  }

  private registerRequestUserInput(server: McpServer): void {
    server.tool(
      'request_user_input',
      'Pause and request input from a human user (stub).',
      {
        question: z.string().describe('The question to ask the user.'),
        context: z
          .string()
          .optional()
          .describe(
            'Optional context to help the user understand the request.',
          ),
      },
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: 'User input requests are not yet implemented.',
            },
          ],
        };
      },
    );
  }

  private registerRequestAgentConsultation(server: McpServer): void {
    server.tool(
      'request_agent_consultation',
      'Consult another agent by role (stub).',
      {
        role_name: z
          .string()
          .describe('The role name of the agent to consult.'),
        question: z.string().describe('The question to pose to the agent.'),
        context: z
          .string()
          .optional()
          .describe('Optional context for the consultation.'),
      },
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: 'Agent consultation is not yet implemented.',
            },
          ],
        };
      },
    );
  }
}
