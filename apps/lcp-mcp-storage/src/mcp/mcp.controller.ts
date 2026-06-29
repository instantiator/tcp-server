import { BaseMcpController } from '@lcp/shared';
import { Controller } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StorageToolsService } from './storage-tools.service';

/** MCP controller for the storage service. */
@Controller('mcp')
export class McpController extends BaseMcpController {
  constructor(private readonly tools: StorageToolsService) {
    super();
  }

  protected createServer(): McpServer {
    return this.tools.createServer();
  }
}
