import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { TextContent, Tool } from '@modelcontextprotocol/sdk/types.js';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

/** A resolved LangChain tool loaded from an MCP server. */
export interface McpTool {
  tool: DynamicStructuredTool;
  serverName: string;
  toolName: string;
}

/**
 * Connects to one or more MCP servers, fetches their tool lists, and returns
 * LangChain {@link DynamicStructuredTool} instances ready for use in a LangGraph agent.
 *
 * Tools from different servers are disambiguated by prefixing the tool name
 * with the server name: `{serverName}__{toolName}`.
 */
@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);

  /**
   * Loads tools from all named servers. The `serverUrls` map associates each
   * server name (as stored in {@link LcpRole.mcpServerList}) with its HTTP URL.
   *
   * Servers that fail to connect are logged and skipped — the agent will still
   * run with whichever servers did respond.
   */
  async loadTools(
    serverNames: string[],
    serverUrls: Record<string, string>,
  ): Promise<McpTool[]> {
    const results: McpTool[] = [];

    for (const name of serverNames) {
      const url = serverUrls[name];
      if (!url) {
        this.logger.warn(
          `No URL configured for MCP server "${name}" — skipping`,
        );
        continue;
      }
      try {
        const tools = await this.fetchToolsFrom(name, url);
        results.push(...tools);
      } catch (err) {
        this.logger.warn(
          `Failed to load tools from MCP server "${name}" at ${url}: ${String(err instanceof Error ? err.message : err)}`,
        );
      }
    }

    return results;
  }

  private async fetchToolsFrom(
    serverName: string,
    baseUrl: string,
  ): Promise<McpTool[]> {
    const client = new Client({ name: 'lcp', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl.replace(/\/$/, '')}/mcp`),
    );
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      // Pass baseUrl rather than client — each tool invocation opens its own connection
      return tools.map((t) => this.convertTool(serverName, baseUrl, t));
    } finally {
      await client.close();
    }
  }

  private convertTool(
    serverName: string,
    baseUrl: string,
    mcpTool: Tool,
  ): McpTool {
    const toolName = `${serverName}__${mcpTool.name}`;
    const schema = buildZodSchema(mcpTool.inputSchema);
    const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;

    const tool = new DynamicStructuredTool({
      name: toolName,
      description: mcpTool.description ?? `${serverName} tool: ${mcpTool.name}`,
      schema,
      func: async (input: Record<string, unknown>) => {
        // Fresh connection per call — avoids holding open connections across LLM turns
        const callClient = new Client({ name: 'lcp', version: '0.0.1' });
        const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
        await callClient.connect(transport);
        try {
          const raw = await callClient.callTool({
            name: mcpTool.name,
            arguments: input,
          });
          const parsed = CallToolResultSchema.safeParse(raw);
          const textContent = parsed.success
            ? parsed.data.content.find(
                (c): c is TextContent => c.type === 'text',
              )
            : undefined;
          return textContent ? String(textContent.text) : '';
        } finally {
          await callClient.close();
        }
      },
    });

    return { tool, serverName, toolName };
  }
}

/**
 * Converts an MCP JSON Schema object into a Zod schema for use with
 * {@link DynamicStructuredTool}. Handles string, number, boolean, and object
 * types. Unrecognised types fall back to `z.unknown()`.
 */
function buildZodSchema(
  inputSchema: Record<string, unknown>,
): z.ZodObject<Record<string, z.ZodType>> {
  const properties =
    (inputSchema['properties'] as Record<string, unknown>) ?? {};
  const required = (inputSchema['required'] as string[]) ?? [];

  const shape: Record<string, z.ZodType> = {};
  for (const [key, def] of Object.entries(properties)) {
    const field = jsonSchemaFieldToZod(def as Record<string, unknown>);
    shape[key] = required.includes(key) ? field : field.optional();
  }

  return z.object(shape);
}

function jsonSchemaFieldToZod(field: Record<string, unknown>): z.ZodType {
  switch (field['type']) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(
        jsonSchemaFieldToZod((field['items'] as Record<string, unknown>) ?? {}),
      );
    case 'object':
      return buildZodSchema(field);
    default:
      return z.unknown();
  }
}
