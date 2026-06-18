import { Injectable } from '@nestjs/common';
import { UUID } from 'crypto';
import { LcpCompany } from '@lcp/shared';
import { DbService } from '../db/db.service';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';

@Injectable()
export class ApiService {
  constructor(private readonly dbService: DbService) {}

  async createCompany(
    template: LcpCompanyTemplate,
    slug: string,
  ): Promise<LcpCompany> {
    return await this.dbService.createCompany(template, slug);
  }

  async setCompany(id: UUID, company: Partial<LcpCompany>) {
    return await this.dbService.setCompany({ ...company, id }, false);
  }

  async getCompany(id: UUID): Promise<LcpCompany | null> {
    return await this.dbService.getCompany(id);
  }
}
