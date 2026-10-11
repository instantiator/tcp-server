import { MODE_TOOLS, type TcpAssignmentMode } from '@tcp/shared';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DbService } from '../db/db.service';
import { ToolFootprintDto } from './dto/tool-footprint.dto';
import { ToolFootprintService } from './tool-footprint.service';

const MODES = Object.keys(MODE_TOOLS) as TcpAssignmentMode[];

/** Reports what a role's MCP tool schemas cost per turn, for `estimate-context-window`. */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/company' })
export class ToolFootprintController {
  constructor(
    private readonly db: DbService,
    private readonly footprints: ToolFootprintService,
  ) {}

  /**
   * Counts the tool schemas a role's agents are sent on every turn in `mode`
   * (default `implement`), per MCP server, after the company's and role's
   * server toggles.
   */
  @ApiOperation({ summary: "Count a role's MCP tool schema tokens" })
  @ApiOkResponse({ type: ToolFootprintDto })
  @ApiQuery({ name: 'mode', required: false, enum: MODES })
  @CompanyScope({ from: 'param', key: 'companyId', via: 'company' })
  @Get(':companyId/roles/by-slug/:slug/tool-footprint')
  async toolFootprint(
    @Param('companyId') companyId: string,
    @Param('slug') slug: string,
    @Query('mode') mode: string = 'implement',
  ): Promise<ToolFootprintDto> {
    if (!MODES.includes(mode as TcpAssignmentMode)) {
      throw new BadRequestException(`mode must be one of ${MODES.join(', ')}`);
    }
    const company = await this.db.getCompany(companyId);
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);
    const role = await this.db.findRoleByIdOrSlug(company.id, slug);
    if (!role) {
      throw new NotFoundException(
        `Role ${slug} not found in company ${company.id}`,
      );
    }
    return this.footprints.footprint(company, role, mode as TcpAssignmentMode);
  }
}
