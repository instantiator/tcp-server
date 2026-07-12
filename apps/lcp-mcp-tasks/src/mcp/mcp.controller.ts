import { BaseMcpController } from '@lcp/shared';
import { Controller } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TasksToolsService } from './tasks-tools.service';

/** MCP controller for the tasks service. */
@Controller('mcp')
export class McpController extends BaseMcpController {
  constructor(private readonly tools: TasksToolsService) {
    super();
  }

  protected createServer(): McpServer {
    return this.tools.createServer();
  }
}
