import { Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import type { UUID } from 'crypto';
import type { NewTcpCompany, TcpCompany } from '../models/TcpCompany.model';
import { ApiService } from './api.service';

@Controller({ path: 'api/company' })
export class CompanyController {
  constructor(private readonly api: ApiService) {}

  @Post()
  async postCompany(@Body() company: NewTcpCompany) {
    await this.api.createCompany(company);
  }

  @Put(':id')
  async putCompany(@Param('id') id: UUID, @Body() company: TcpCompany) {
    await this.api.updateCompany(id, company);
  }

  @Get(':id')
  async getCompany(@Param('id') id: UUID): Promise<TcpCompany | null> {
    return await this.api.getCompany(id);
  }
}
