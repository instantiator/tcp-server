import { Injectable } from '@nestjs/common';
import { LcpCompany } from '@lcp/shared';
import type { UUID } from 'crypto';
import type { DeepPartial } from 'typeorm';
import { DbService } from '../db/db.service';
import { LcpCompanyTemplate } from '../templates/LcpCompanyTemplate';
import { isUUID } from '../utils/ObjectUtils';

/** Orchestrates company operations, delegating persistence to {@link DbService}. */
@Injectable()
export class ApiService {
  constructor(private readonly dbService: DbService) {}

  /**
   * Creates a new {@link LcpCompany} from the given template and slug,
   * replacing any existing record with the same slug. Adds `creatorIdentifier`
   * as a {@link CompanyUser} with `memberType: 'creator'`.
   */
  async createCompany(
    template: LcpCompanyTemplate,
    slug: string,
    creatorIdentifier: string,
    creatorName?: string | null,
  ): Promise<LcpCompany> {
    return await this.dbService.createCompany(
      template,
      slug,
      creatorIdentifier,
      creatorName,
    );
  }

  /**
   * Updates the fields of an existing {@link LcpCompany} identified by UUID
   * or slug (the path parameter is checked against UUID shape to tell them
   * apart). Throws {@link NotFoundException} (via {@link DbService.setCompany})
   * if no company matches — this never falls back to creating a new record.
   */
  async setCompany(
    pathIdentifier: string,
    partial: DeepPartial<Omit<LcpCompany, 'id'>>,
  ): Promise<LcpCompany> {
    return await this.dbService.setCompany(
      partial,
      isUUID(pathIdentifier)
        ? { id: pathIdentifier }
        : { slug: pathIdentifier },
    );
  }

  /**
   * Retrieves a {@link LcpCompany} by its UUID or slug.
   * Returns `null` when no match is found.
   */
  async getCompany(id: UUID): Promise<LcpCompany | null> {
    return await this.dbService.getCompany(id);
  }
}
