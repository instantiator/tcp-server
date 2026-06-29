import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { LcpCompany, LcpRole } from '@lcp/shared';
import { DbService } from '../db/db.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ApiService } from './api.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';

/** REST controller for company (tenant) create, read, and update operations. */
@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(
    private readonly api: ApiService,
    private readonly db: DbService,
  ) {}

  /** Returns all {@link LcpCompany} records. */
  @ApiOperation({ summary: 'List all companies' })
  @Get()
  async listCompanies(): Promise<LcpCompany[]> {
    return this.db.listCompanies();
  }

  /**
   * Creates or replaces a {@link LcpCompany}.
   * If a company with the same slug already exists it is replaced.
   */
  @ApiOperation({ summary: 'Create or replace a company' })
  @Post()
  async postCompany(@Body() body: CreateCompanyDto): Promise<LcpCompany> {
    const { slug, ...template } = body;
    return await this.api.createCompany(template, slug);
  }

  /**
   * Partially updates the fields of an existing {@link LcpCompany} identified by `id`.
   * Accepts a partial body so nested fields such as `llmDefault.model` can be
   * patched without overwriting the whole object. The `id` field is immutable and
   * must not be included in the request body.
   */
  @ApiOperation({ summary: 'Partially update a company' })
  @Put(':id')
  async putCompany(
    @Param('id') id: UUID,
    @Body() partial: UpdateCompanyDto,
  ): Promise<LcpCompany> {
    return this.api.setCompany(id, partial);
  }

  /**
   * Retrieves a {@link LcpCompany} by its UUID or slug.
   * Returns an empty body when no match is found (see TODO below).
   */
  @ApiOperation({ summary: 'Get a company by ID or slug' })
  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<LcpCompany | null> {
    return await this.api.getCompany(id);
  }

  /** Returns all {@link LcpRole} records belonging to the given company. */
  @ApiOperation({ summary: 'List roles for a company' })
  @Get(':id/roles')
  async listRoles(@Param('id') id: UUID): Promise<LcpRole[]> {
    return this.db.listRoles(id);
  }
}
