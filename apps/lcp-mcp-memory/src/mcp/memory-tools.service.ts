import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with stub memory tools.
 * A new server is created per request so state is never shared across sessions.
 */
@Injectable()
export class MemoryToolsService {
  /** Creates and returns a configured McpServer with all memory tools registered. */
  createServer(): McpServer {
    const server = new McpServer({
      name: 'lcp-mcp-memory',
      version: '1.0.0',
    });

    this.registerDescribeServer(server);
    this.registerRecall(server);
    this.registerRemember(server);
    this.registerSearchKnowledge(server);

    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.tool(
      'describe_server',
      'Returns an overview of the memory service and its tools.',
      {},
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: [
                '## Memory Service',
                '',
                "Provides semantic search over the role's knowledge base and episodic memory.",
                'This service is not yet fully implemented — tool calls return stub responses.',
                '',
                '### Tools',
                '- **describe_server** — this overview',
                '- **recall(query, top_k?)** — search episodic and knowledge memory (stub)',
                '- **remember(content, tags?)** — store an episodic memory entry (stub)',
                '- **search_knowledge(query, top_k?)** — search the role knowledge base only (stub)',
              ].join('\n'),
            },
          ],
        };
      },
    );
  }

  private registerRecall(server: McpServer): void {
    server.tool(
      'recall',
      'Search episodic and knowledge memory (stub).',
      {
        query: z.string().describe('The search query.'),
        top_k: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return.'),
      },
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: 'Memory recall is not yet implemented. Use the RAG context already injected into your initial prompt for knowledge retrieval.',
            },
          ],
        };
      },
    );
  }

  private registerRemember(server: McpServer): void {
    server.tool(
      'remember',
      'Store an episodic memory entry (stub).',
      {
        content: z.string().describe('The content to remember.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tags to associate with the memory.'),
      },
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: 'Episodic memory storage is not yet implemented.',
            },
          ],
        };
      },
    );
  }

  private registerSearchKnowledge(server: McpServer): void {
    server.tool(
      'search_knowledge',
      'Search the role knowledge base only (stub).',
      {
        query: z.string().describe('The search query.'),
        top_k: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Maximum number of results to return.'),
      },
      (): ToolResult => {
        return {
          content: [
            {
              type: 'text',
              text: 'Knowledge search is not yet implemented. Use the RAG context already injected into your initial prompt.',
            },
          ],
        };
      },
    );
  }
}
