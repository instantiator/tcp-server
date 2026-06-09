import { Injectable } from '@nestjs/common';
import { UUID } from 'crypto';
import { DbService } from '../db/db.service';
import { TcpCompany } from '../models';

@Injectable()
export class ApiService {
  constructor(private readonly dbService: DbService) {}

  async createCompany(company: Partial<TcpCompany>) {
    return await this.dbService.setCompany(company, true);
  }

  async updateCompany(id: UUID, company: Partial<TcpCompany>) {
    return await this.dbService.setCompany({ ...company, id }, false);
  }

  async getCompany(id: UUID): Promise<TcpCompany | null> {
    return await this.dbService.getCompany(id);
  }
}
