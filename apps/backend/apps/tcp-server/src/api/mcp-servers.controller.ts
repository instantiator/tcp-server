import { Controller, Get, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { MCP_REGISTRY, resolveMcpServerUrls } from '@tcp/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { NoCompanyScope } from '../auth/company-scope.decorator';
import { McpServerResponseDto } from './dto/mcp-server-response.dto';

/**
 * Publishes the MCP server catalogue. The web role form offers one setting per
 * server, and the registry is otherwise only known to the server.
 */
@ApiTags('mcp-servers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/mcp-servers' })
export class McpServersController {
  constructor(private readonly config: ConfigService) {}

  /** Lists every registered server, flagging those this deployment has configured. */
  @ApiOperation({ summary: 'List the MCP servers a role can use' })
  @ApiOkResponse({ type: McpServerResponseDto, isArray: true })
  @NoCompanyScope('the same platform-wide catalogue for every company')
  @Get()
  list(): McpServerResponseDto[] {
    const urls = resolveMcpServerUrls(this.config);
    return MCP_REGISTRY.map(({ name, usage }) => ({
      name,
      usage,
      available: name in urls,
    }));
  }
}
