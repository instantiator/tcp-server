import { BaseMcpController } from '@lcp/shared';
import { Controller } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { MemoryToolsService } from './memory-tools.service';

/** MCP controller for the memory service. */
@Controller('mcp')
export class McpController extends BaseMcpController {
  constructor(private readonly tools: MemoryToolsService) {
    super();
  }

  protected createServer(): McpServer {
    return this.tools.createServer();
  }
}
