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
/**
 * A server a run needs couldn't be reached when its tools were loaded. Named
 * so the run-failure classifier can say which service is down, rather than
 * the run carrying on without that server's tools.
 */
export class McpServerUnavailableError extends Error {
  override readonly name = 'McpServerUnavailableError';

  constructor(
    readonly serverName: string,
    cause: string,
  ) {
    super(`MCP server "${serverName}" couldn't be reached: ${cause}`);
  }
}

/** Told whether each tool call managed to connect to its server. */
type ConnectionListener = (ok: boolean, err: unknown) => void;

/** How {@link McpClientService.loadTools} treats a server that can't be reached. */
export interface LoadToolsOptions {
  /**
   * Throw {@link McpServerUnavailableError} instead of skipping the server.
   * A server with no URL is still skipped: that is a deployment choice.
   */
  required?: boolean;
  /**
   * Called once a server has refused {@link MAX_MCP_CONNECT_FAILURES}
   * connections in a row from these tools. A failed call otherwise goes back
   * to the model as an ordinary tool error, which it can't fix by retrying.
   */
  onServerDown?: (err: McpServerUnavailableError) => void;
}

/** Connection failures in a row, to one server, that count as it being down. */
export const MAX_MCP_CONNECT_FAILURES = 3;

@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);

  /**
   * Loads tools from all named servers. The `serverUrls` map associates each
   * server name (as stored in {@link TcpRole.mcpServerList}) with its HTTP URL.
   *
   * Servers that fail to connect are logged and skipped — the agent will still
   * run with whichever servers did respond — unless `options.required` asks
   * for a failure instead.
   *
   * @param context identity values (`agentId`, `companyId`) for the current
   *   agent run. Any matching tool parameter is removed from what the LLM
   *   sees and the real value substituted on every call — see {@link McpToolContext}.
   */
  async loadTools(
    serverNames: string[],
    serverUrls: Record<string, string>,
    context: McpToolContext = {},
    options: LoadToolsOptions = {},
  ): Promise<McpTool[]> {
    const results: McpTool[] = [];
    // Consecutive connection failures per server, for this set of tools only.
    const failures = new Map<string, number>();

    for (const name of serverNames) {
      const url = serverUrls[name];
      if (!url) {
        this.logger.warn(
          `No URL configured for MCP server "${name}" — skipping`,
        );
        continue;
      }
      try {
        const tools = await this.fetchToolsFrom(name, url, context, (ok, e) =>
          this.noteConnection(name, ok, e, failures, options.onServerDown),
        );
        results.push(...tools);
      } catch (err) {
        const cause = String(err instanceof Error ? err.message : err);
        if (options.required) throw new McpServerUnavailableError(name, cause);
        this.logger.warn(
          `Failed to load tools from MCP server "${name}" at ${url}: ${cause}`,
        );
      }
    }

    return results;
  }

  /**
   * Keeps the count of connection failures in a row to `serverName`, and
   * reports the server down when the count reaches the limit.
   */
  private noteConnection(
    serverName: string,
    ok: boolean,
    err: unknown,
    failures: Map<string, number>,
    onServerDown: LoadToolsOptions['onServerDown'],
  ): void {
    const count = ok ? 0 : (failures.get(serverName) ?? 0) + 1;
    failures.set(serverName, count);
    if (count === MAX_MCP_CONNECT_FAILURES && onServerDown) {
      const cause = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `MCP server "${serverName}" refused ${count} connections in a row: ${cause}`,
      );
      onServerDown(new McpServerUnavailableError(serverName, cause));
    }
  }

  private async fetchToolsFrom(
    serverName: string,
    baseUrl: string,
    context: McpToolContext,
    onConnect: ConnectionListener,
  ): Promise<McpTool[]> {
    const client = new Client({ name: 'tcp', version: '0.0.1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${baseUrl.replace(/\/$/, '')}/mcp`),
    );
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      // Pass baseUrl rather than client — each tool invocation opens its own connection
      return tools.map((t) =>
        this.convertTool(serverName, baseUrl, t, context, onConnect),
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
    onConnect: ConnectionListener,
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
        const callClient = new Client({ name: 'tcp', version: '0.0.1' });
        const transport = new StreamableHTTPClientTransport(new URL(mcpUrl));
        try {
          await callClient.connect(transport);
        } catch (err) {
          onConnect(false, err);
          throw err;
        }
        onConnect(true, undefined);
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
    case 'object': {
      // An object with no declared properties is a free-form record (a
      // records-server row, say): z.object({}) would strip every key from it.
      if (!field['properties']) return z.record(z.string(), z.unknown());
      const built = buildZodSchema(field);
      return field['additionalProperties'] === false ? built : built.loose();
    }
    default:
      return z.unknown();
  }
}
