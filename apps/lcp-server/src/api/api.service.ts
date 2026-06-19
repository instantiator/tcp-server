import { Injectable } from '@nestjs/common';
import { UUID } from 'crypto';
import { LcpCompany } from '@lcp/shared';
import { DbService } from '../db/db.service';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';

/** Orchestrates company operations, delegating persistence to {@link DbService}. */
@Injectable()
export class ApiService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Creates a new {@link LcpCompany} from the given template and slug,
   * replacing any existing record with the same slug.
   */
  async createCompany(
    template: LcpCompanyTemplate,
    slug: string,
  ): Promise<LcpCompany> {
    return await this.dbService.createCompany(template, slug);
  }

  /**
   * Replaces the fields of an existing {@link LcpCompany} by id,
   * or creates it if no record with that id exists.
   */
  async setCompany(id: UUID, company: Partial<LcpCompany>) {
    return await this.dbService.setCompany({ ...company, id }, false);
  }

  /**
   * Retrieves a {@link LcpCompany} by its UUID or slug.
   * Returns `null` when no match is found.
   */
  async getCompany(id: UUID): Promise<LcpCompany | null> {
    return await this.dbService.getCompany(id);
  }
}
