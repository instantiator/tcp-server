import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { StorageToolsService } from './storage-tools.service';

/**
 * Handles stateless MCP requests over HTTP using the StreamableHTTP transport.
 * A fresh server and transport are created per POST to avoid session state leakage.
 */
@Controller('mcp')
export class McpController {
  constructor(private readonly tools: StorageToolsService) {}

  /** Handles a single MCP JSON-RPC request. */
  @Post()
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server: McpServer = this.tools.createServer();
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

  /** Rejects unsupported HTTP methods. */
  @Get()
  @Delete()
  methodNotAllowed(@Res() res: Response): void {
    res.status(405).end();
  }
}
