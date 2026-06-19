import { LcpRole } from '@lcp/shared';
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import type { LcpRoleTemplate } from '../templates/LcpRoleTemplate';
import { DbService } from '../db/db.service';

/** REST controller for {@link LcpRole} create and read operations. */
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

  /** Retrieves a role by its UUID. Returns 404 when not found. */
  @Get(':id')
  async getRole(@Param('id') id: string): Promise<LcpRole> {
    const role = await this.db.getRole(id);
    if (!role) throw new NotFoundException(`Role ${id} not found`);
    return role;
  }
}
