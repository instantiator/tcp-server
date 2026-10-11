import { BaseMcpController } from '@tcp/shared';
import { Controller } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RecordsToolsService } from './records-tools.service';

/** MCP controller for the records service. */
@Controller('mcp')
export class McpController extends BaseMcpController {
  constructor(private readonly tools: RecordsToolsService) {
    super();
  }

  protected createServer(): McpServer {
    return this.tools.createServer();
  }
}
