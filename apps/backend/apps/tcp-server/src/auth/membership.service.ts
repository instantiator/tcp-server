import { CompanyUser } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { In, Repository } from 'typeorm';

/**
 * Answers the two authorization questions the API asks: is this caller a
 * member of that company, and is this caller an administrator (ADR-011,
 * phase-02 amendment).
 */
@Injectable()
export class MembershipService {
  /** Identifiers from `TCP_ADMIN_IDENTIFIERS`, parsed once at construction. */
  private readonly admins: readonly string[];

  constructor(
    config: ConfigService,
    @InjectRepository(CompanyUser)
    private readonly companyUserRepo: Repository<CompanyUser>,
  ) {
    this.admins = (config.get<string>('TCP_ADMIN_IDENTIFIERS') ?? '')
      .split(',')
      .map((identifier) => identifier.trim())
      .filter((identifier) => identifier !== '');
  }

  /**
   * True when any of the caller's identifiers has a {@link CompanyUser} row
   * in this company. Callers pass every identifier form they hold — a row may
   * be keyed by the OIDC `sub` **or** an email address, and matching on `sub`
   * alone denies email-keyed members with a message that reads like a
   * permissions bug and is a data-shape bug (ADR-011).
   */
  async isMember(identifiers: string[], companyId: UUID): Promise<boolean> {
    // A token carrying neither claim is a member of nothing. Returning early
    // also keeps `In([])` — which matches every row on some drivers — out of
    // reach entirely.
    if (identifiers.length === 0) return false;
    const row = await this.companyUserRepo.findOne({
      where: { companyId, identifier: In(identifiers) },
      select: { id: true },
    });
    return row !== null;
  }

  /**
   * True when any identifier is named in `TCP_ADMIN_IDENTIFIERS`. An unset or
   * empty variable means nobody: a deployment that forgets to configure its
   * administrators loses the administrative view rather than granting it.
   */
  isAdmin(identifiers: string[]): boolean {
    return identifiers.some((identifier) => this.admins.includes(identifier));
  }
}
