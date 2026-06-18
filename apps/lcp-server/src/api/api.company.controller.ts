import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type { UUID } from 'crypto';
import { LcpCompany } from '@lcp/shared';
import type { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { ApiService } from './api.service';

@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(private readonly api: ApiService) {}

  @Post()
  async postCompany(
    @Body() body: LcpCompanyTemplate & { slug: string },
  ): Promise<LcpCompany> {
    const { slug, ...template } = body;
    return await this.api.createCompany(template, slug);
  }

  @Put(':id')
  async putCompany(@Param('id') id: UUID, @Body() company: LcpCompany) {
    // Only reject when the body explicitly provides a conflicting id
    if (company.id && id !== company.id) {
      throw new Error(`Company with id ${company.id} PUT to path id ${id}`);
    }
    await this.api.setCompany(id, company);
  }

  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<LcpCompany | null> {
    return await this.api.getCompany(id);
  }
}
