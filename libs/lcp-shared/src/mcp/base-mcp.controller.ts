import { Delete, Get, Post, Req, Res } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';

/**
 * Abstract base for stateless MCP-over-HTTP controllers.
 *
 * A fresh {@link McpServer} and {@link StreamableHTTPServerTransport} are
 * created per POST to avoid session-state leakage between callers. Concrete
 * subclasses apply `@Controller('mcp')` and implement {@link createServer}
 * by delegating to their injected `ToolsService`.
 */
export abstract class BaseMcpController {
  /** Returns a configured {@link McpServer} for a single request. */
  protected abstract createServer(): McpServer;

  /** Handles a single MCP JSON-RPC request. */
  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server: McpServer = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(
      req,
      res,
      req.body as Record<string, unknown>,
    );
  }

  /** Rejects GET requests with 405 Method Not Allowed. */
  @Get()
  rejectGet(@Res() res: Response): void {
    res.status(405).end();
  }

  /** Rejects DELETE requests with 405 Method Not Allowed. */
  @Delete()
  rejectDelete(@Res() res: Response): void {
    res.status(405).end();
  }
}
