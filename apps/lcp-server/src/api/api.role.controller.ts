import { LcpRole } from '@lcp/shared';
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { UUID } from 'crypto';
import type { DeepPartial } from 'typeorm';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DbService } from '../db/db.service';
import type { LcpRoleTemplate } from '../templates/LcpRoleTemplate';

/** REST controller for {@link LcpRole} create, read, and update operations. */
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/role' })
export class RoleController {
  constructor(private readonly db: DbService) {}

  /**
   * Creates a new role for the given company.
   * All fields from {@link LcpRoleTemplate} are required.
   */
  @Post()
  async createRole(@Body() body: LcpRoleTemplate): Promise<LcpRole> {
    return this.db.createRole(body);
  }

  /**
   * Partially updates an existing {@link LcpRole} identified by `id`.
   * Accepts a deep-partial body, so nested fields such as `llmConfig.model` can be
   * patched without overwriting the whole object. The `id` and `company` fields
   * are immutable and must not be included in the request body.
   */
  @Put(':id')
  async updateRole(
    @Param('id') id: UUID,
    @Body() partial: DeepPartial<Omit<LcpRole, 'id' | 'company'>>,
  ): Promise<LcpRole> {
    const role = await this.db.updateRole(id, partial);
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }

  /** Retrieves a role by its UUID. Returns 404 when not found. */
  @Get(':id')
  async getRole(@Param('id') id: UUID): Promise<LcpRole> {
    const role = await this.db.getRole(id);
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }
}
