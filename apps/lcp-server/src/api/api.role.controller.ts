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
import type { LcpRoleTemplate } from '../templates/LcpRoleTemplate';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

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
   * Only the provided fields are changed; omitted fields are left as-is.
   */
  @Put(':id')
  async updateRole(
    @Param('id') id: string,
    @Body() partial: Partial<LcpRole>,
  ): Promise<LcpRole> {
    const role = await this.db.updateRole(id, partial);
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }

  /** Retrieves a role by its UUID. Returns 404 when not found. */
  @Get(':id')
  async getRole(@Param('id') id: string): Promise<LcpRole> {
    const role = await this.db.getRole(id);
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }
}
