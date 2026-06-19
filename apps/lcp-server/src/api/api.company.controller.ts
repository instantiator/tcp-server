import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { UUID } from 'crypto';
import { LcpCompany, LcpRole } from '@lcp/shared';
import type { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { DbService } from '../db/db.service';
import { ApiService } from './api.service';

/** REST controller for company (tenant) create, read, and update operations. */
@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(
    private readonly api: ApiService,
    private readonly db: DbService,
  ) {}

  /**
   * Creates or replaces a {@link LcpCompany}.
   * If a company with the same slug already exists it is replaced.
   */
  @Post()
  async postCompany(
    @Body() body: LcpCompanyTemplate & { slug: string },
  ): Promise<LcpCompany> {
    const { slug, ...template } = body;
    return await this.api.createCompany(template, slug);
  }

  /**
   * Updates the fields of an existing {@link LcpCompany} identified by `id`.
   * Rejects the request when the body's `id` conflicts with the path `id`.
   */
  @Put(':id')
  async putCompany(@Param('id') id: UUID, @Body() company: LcpCompany) {
    // Only reject when the body explicitly provides a conflicting id
    if (company.id && id !== company.id) {
      throw new BadRequestException(
        `Body id ${company.id} does not match path id ${id}`,
      );
    }
    await this.api.setCompany(id, company);
  }

  /**
   * Retrieves a {@link LcpCompany} by its UUID or slug.
   * Returns an empty body when no match is found (see TODO below).
   */
  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<LcpCompany | null> {
    return await this.api.getCompany(id);
  }

  /** Returns all {@link LcpRole} records belonging to the given company. */
  @Get(':id/roles')
  async listRoles(@Param('id') id: UUID): Promise<LcpRole[]> {
    return this.db.listRoles(id);
  }
}
