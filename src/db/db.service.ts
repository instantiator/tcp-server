import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TcpCompany } from '../models';
import { isUUID } from '../utils/ObjectUtils';

@Injectable()
export class DbService {
  constructor(
    @InjectRepository(TcpCompany)
    private readonly repo: Repository<TcpCompany>,
  ) {}

  /** Either creates or updates a company, using the provided data */
  async setCompany(company: Partial<TcpCompany>, replace: boolean) {
    if (replace && company.slug) {
      await this.repo.delete({ slug: company.slug });
    }
    await this.repo.save(this.repo.create(company));
  }

  /** Retrieves a company by its id or slug */
  async getCompany(identifier: string): Promise<TcpCompany | null> {
    return isUUID(identifier)
      ? await this.repo.findOneBy({ id: identifier })
      : await this.repo.findOneBy({ slug: identifier });
  }
}
