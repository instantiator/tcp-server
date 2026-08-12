import { TcpRole } from '@tcp/shared';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { DbService } from '../db/db.service';
import { CreateRoleDto, UpdateRoleDto } from './dto/role.dto';
import { RoleResponseDto } from './dto/entity-response.dto';
import { computeRoleWarnings, setWarningsHeader } from './validation-warnings';

/**
 * REST controller for {@link TcpRole} create, read, and update operations.
 *
 * `:id` here is always a UUID — a bare role slug is ambiguous without
 * knowing the company (role slugs are unique only within their company, not
 * globally). Slug-based role lookup is exposed on the company-scoped route
 * (`GET/PUT /api/company/:companyId/roles/by-slug/:slug`, see
 * {@link CompanyController}).
 */
@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/role' })
export class RoleController {
  constructor(private readonly db: DbService) {}

  /**
   * Creates a new role for the given company. Soft data-quality warnings
   * (e.g. no `knowledgeDomains`, blank `rolePrompt`) are reported via the
   * `X-Tcp-Warnings` response header — the role is still created.
   */
  @ApiOperation({ summary: 'Create a role' })
  @ApiOkResponse({ type: RoleResponseDto })
  @CompanyScope({ from: 'body', key: 'companyId', via: 'company' })
  @Post()
  async createRole(
    @Body() body: CreateRoleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TcpRole> {
    const role = await this.db.setRole(body);
    setWarningsHeader(res, computeRoleWarnings(role));
    return role;
  }

  /**
   * Partially updates an existing {@link TcpRole} identified by `id`.
   * Accepts a partial body so nested fields such as `llmConfig.model` can be
   * patched without overwriting the whole object. The `id` and `company` fields
   * are immutable and must not be included in the request body. See
   * {@link createRole} for the `X-Tcp-Warnings` header.
   */
  @ApiOperation({ summary: 'Partially update a role' })
  @ApiOkResponse({ type: RoleResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'role' })
  @Put(':id')
  async updateRole(
    @Param('id') id: UUID,
    @Body() partial: UpdateRoleDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TcpRole> {
    const role = await this.db.setRole(partial, { id });
    setWarningsHeader(res, computeRoleWarnings(role));
    return role;
  }

  /** Retrieves a role by its UUID. Returns 404 when not found. */
  @ApiOperation({ summary: 'Get a role by ID' })
  @ApiOkResponse({ type: RoleResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'role' })
  @Get(':id')
  async getRole(@Param('id') id: UUID): Promise<TcpRole> {
    const role = await this.db.getRole(id);
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }

  /**
   * Deletes a role by UUID. Cascades to the role's agents, knowledge
   * chunks, episodic memory, and conversations.
   */
  @ApiOperation({ summary: 'Delete a role by ID' })
  @CompanyScope({ from: 'param', key: 'id', via: 'role' })
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRole(@Param('id') id: UUID): Promise<void> {
    const deleted = await this.db.deleteRole(id);
    if (!deleted) throw new NotFoundException(`Role ${id} not found`);
  }
}
