import { BaseMcpController } from '@tcp/shared';
import { Controller } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UtilitiesToolsService } from './utilities-tools.service';

/** MCP controller for the utilities service. */
@Controller('mcp')
export class McpController extends BaseMcpController {
  constructor(private readonly tools: UtilitiesToolsService) {
    super();
  }

  protected createServer(): McpServer {
    return this.tools.createServer();
  }
}
