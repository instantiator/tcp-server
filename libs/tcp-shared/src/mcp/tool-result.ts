import { Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import axios, { AxiosError } from 'axios';

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/** The error body shape tcp-server's internal endpoints return. */
interface ServerErrorBody {
  /** NestJS's own message, a string or an array of validation strings. */
  message?: string | string[];
  /** Structured validation failures, each carrying prose written for the model. */
  errors?: { llmHint: string }[];
}

/** A successful tool result carrying `text` back to the model. */
export function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] };
}

/** A failed tool result, prefixed so the model reads the text as an error. */
export function err(text: string): ToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }] };
}

/**
 * Picks the most actionable message out of a tcp-server error body.
 *
 * `errors[].llmHint` wins where present — it is written specifically to tell
 * the model how to correct its call — falling back to NestJS's own `message`.
 */
function messageFromBody(
  body: ServerErrorBody | undefined,
): string | undefined {
  if (body?.errors?.length) return body.errors.map((e) => e.llmHint).join(' ');
  const raw = body?.message;
  return Array.isArray(raw) ? raw.join('; ') : raw;
}

/**
 * Relays a 4xx server error's message to the model as a normal (non-error)
 * tool result so it can self-correct and retry; falls back to `fallback` for
 * 5xx and transport errors it cannot act on.
 *
 * Pass `ctx` to log the underlying error against the calling tool's name —
 * relayed 4xx responses are expected and are not logged.
 */
export function relay4xxOrError(
  e: unknown,
  fallback: string,
  ctx?: { tool: string; logger: Logger },
): ToolResult {
  const axiosErr = e as AxiosError<ServerErrorBody>;
  const status = axiosErr.response?.status;
  if (status && status >= 400 && status < 500) {
    const message = messageFromBody(axiosErr.response?.data);
    if (message) return ok(message);
  }
  if (ctx) ctx.logger.error(`${ctx.tool} failed: ${String(e)}`);
  return err(fallback);
}

/**
 * Extracts a human-readable message from any tcp-server error — validation
 * failures, 404s, transport errors — for tools that report the failure
 * directly rather than relaying it as a correctable result.
 */
export function extractServerErrorMessage(e: unknown): string {
  if (axios.isAxiosError(e)) {
    return messageFromBody(e.response?.data as ServerErrorBody) ?? e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * Registers the conventional `describe_server` tool, which returns a fixed
 * overview of what the MCP server offers.
 *
 * Suits servers whose overview is static; tcp-mcp-tasks tailors its text to
 * the calling agent's mode and registers its own.
 */
export function registerDescribeServer(
  server: McpServer,
  description: string,
  text: string,
): void {
  server.registerTool('describe_server', { description }, (): ToolResult =>
    ok(text),
  );
}
