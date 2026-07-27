import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  type TextContent,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
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
 * Identity values for the agent currently running, used to override
 * LLM-suppliable tool arguments of the same name. The LLM has no reliable
 * way to know its own `agentId` (it's a DB id, not something in its
 * context), and trusting it to assert one is also a correctness/security
 * gap — an LLM could supply a different agent's id. Any tool parameter
 * matching one of these keys is hidden from the LLM-facing schema and the
 * real value is injected at call time instead.
 */
export interface McpToolContext {
  agentId?: string;
  companyId?: string;
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
   * server name (as stored in {@link TcpRole.mcpServerList}) with its HTTP URL.
   *
   * Servers that fail to connect are logged and skipped — the agent will still
   * run with whichever servers did respond.
   *
   * @param context identity values (`agentId`, `companyId`) for the current
   *   agent run. Any matching tool parameter is removed from what the LLM
   *   sees and the real value substituted on every call — see {@link McpToolContext}.
   */
  async loadTools(
    serverNames: string[],
    serverUrls: Record<string, string>,
    context: McpToolContext = {},
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
        const tools = await this.fetchToolsFrom(name, url, context);
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
    context: McpToolContext,
  ): Promise<McpTool[]> {
    const client = new Client({ name: 'lcp', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl.replace(/\/$/, '')}/mcp`),
    );
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      // Pass baseUrl rather than client — each tool invocation opens its own connection
      return tools.map((t) =>
        this.convertTool(serverName, baseUrl, t, context),
      );
    } finally {
      await client.close();
    }
  }

  private convertTool(
    serverName: string,
    baseUrl: string,
    mcpTool: Tool,
    context: McpToolContext,
  ): McpTool {
    const toolName = `${serverName}__${mcpTool.name}`;
    const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;

    // Only override parameters this tool actually declares — context values
    // for tools that don't take an agentId/companyId are simply unused.
    const properties =
      (mcpTool.inputSchema['properties'] as
        Record<string, unknown> | undefined) ?? {};
    const fixedArgs: Record<string, string> = {};
    for (const key of Object.keys(context) as (keyof McpToolContext)[]) {
      const value = context[key];
      if (value !== undefined && key in properties) fixedArgs[key] = value;
    }

    const schema = buildZodSchema(mcpTool.inputSchema, Object.keys(fixedArgs));

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
            // fixedArgs always wins — the LLM never gets a vote on identity.
            arguments: { ...input, ...fixedArgs },
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
 * {@link DynamicStructuredTool}. Handles string, number, boolean, array, and
 * object types, preserving each field's `enum` (as a Zod enum) and
 * `description` — both are load-bearing for the LLM: they're the only place
 * it ever sees a field's allowed values and purpose, since the model binds to
 * this rebuilt schema, not the MCP server's original one. Unrecognised types
 * fall back to `z.unknown()`.
 *
 * @param omitKeys properties to exclude entirely — used to hide
 *   identity fields (`agentId`, `companyId`) that are injected server-side
 *   rather than supplied by the LLM.
 */
function buildZodSchema(
  inputSchema: Record<string, unknown>,
  omitKeys: string[] = [],
): z.ZodObject<Record<string, z.ZodType>> {
  const properties =
    (inputSchema['properties'] as Record<string, unknown>) ?? {};
  const required = (inputSchema['required'] as string[]) ?? [];

  const shape: Record<string, z.ZodType> = {};
  for (const [key, def] of Object.entries(properties)) {
    if (omitKeys.includes(key)) continue;
    const field = jsonSchemaFieldToZod(def as Record<string, unknown>);
    shape[key] = required.includes(key) ? field : field.optional();
  }

  return z.object(shape);
}

function jsonSchemaFieldToZod(field: Record<string, unknown>): z.ZodType {
  const base = jsonSchemaFieldToZodBase(field);
  const description = field['description'];
  return typeof description === 'string' ? base.describe(description) : base;
}

function jsonSchemaFieldToZodBase(field: Record<string, unknown>): z.ZodType {
  switch (field['type']) {
    case 'string': {
      const values = field['enum'];
      if (
        Array.isArray(values) &&
        values.length > 0 &&
        values.every((v) => typeof v === 'string')
      ) {
        return z.enum(values as [string, ...string[]]);
      }
      return z.string();
    }
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
