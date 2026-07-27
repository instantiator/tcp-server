import { Injectable } from '@nestjs/common';
import { AuditEventType, TcpCompany } from '@lcp/shared';
import type { UUID } from 'crypto';
import type { DeepPartial } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { TcpCompanyTemplate } from '../templates/TcpCompanyTemplate';
import { isUUID } from '../utils/ObjectUtils';

/** Orchestrates company operations, delegating persistence to {@link DbService}. */
@Injectable()
export class ApiService {
  constructor(
    private readonly dbService: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Creates a new {@link TcpCompany} from the given template and slug,
   * replacing any existing record with the same slug. Adds `creatorIdentifier`
   * as a {@link CompanyUser} with `memberType: 'creator'`.
   */
  async createCompany(
    template: TcpCompanyTemplate,
    slug: string,
    creatorIdentifier: string,
    creatorName?: string | null,
  ): Promise<TcpCompany> {
    return await this.dbService.createCompany(
      template,
      slug,
      creatorIdentifier,
      creatorName,
    );
  }

  /**
   * Updates the fields of an existing {@link TcpCompany} identified by UUID
   * or slug (the path parameter is checked against UUID shape to tell them
   * apart). Throws {@link NotFoundException} (via {@link DbService.setCompany})
   * if no company matches — this never falls back to creating a new record.
   * Records a `state_change` (`entity:'company'`) row, which the publisher
   * routes to `GET /api/company/:id/events`.
   */
  async setCompany(
    pathIdentifier: string,
    partial: DeepPartial<Omit<TcpCompany, 'id'>>,
  ): Promise<TcpCompany> {
    const company = await this.dbService.setCompany(
      partial,
      isUUID(pathIdentifier)
        ? { id: pathIdentifier }
        : { slug: pathIdentifier },
    );
    await this.audit.record(
      company.id,
      'system',
      null,
      AuditEventType.StateChange,
      { entity: 'company', reason: 'company updated' },
    );
    return company;
  }

  /**
   * Retrieves a {@link TcpCompany} by its UUID or slug.
   * Returns `null` when no match is found.
   */
  async getCompany(id: UUID): Promise<TcpCompany | null> {
    return await this.dbService.getCompany(id);
  }
}
