import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type { UUID } from 'crypto';
import type { NewLcpCompany, LcpCompany } from '../models/LcpCompany.model';
import { ApiService } from './api.service';

@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(private readonly api: ApiService) {}

  @Post()
  async postCompany(@Body() company: NewLcpCompany) {
    await this.api.createCompany(company);
  }

  @Put(':id')
  async putCompany(@Param('id') id: UUID, @Body() company: LcpCompany) {
    await this.api.updateCompany(id, company);
  }

  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<LcpCompany | null> {
    return await this.api.getCompany(id);
  }
}
