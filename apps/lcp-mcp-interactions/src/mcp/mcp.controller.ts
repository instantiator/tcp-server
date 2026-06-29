import { BaseMcpController } from '@lcp/shared';
import { Controller } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InteractionsToolsService } from './interactions-tools.service';

/** MCP controller for the interactions service. */
@Controller('mcp')
export class McpController extends BaseMcpController {
  constructor(private readonly tools: InteractionsToolsService) {
    super();
  }

  protected createServer(): McpServer {
    return this.tools.createServer();
  }
}
