import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { getCurrentUserIdentifiers } from './current-user';
import {
  ADMIN_ONLY,
  COMPANY_SCOPE,
  COMPANY_SCOPE_MISSING_MESSAGE,
  NO_COMPANY_SCOPE,
  type CompanyScopeSpec,
} from './company-scope.decorator';
import { CompanyResolutionService } from './company-resolution.service';
import { MembershipService } from './membership.service';

/**
 * Enforces company membership on every user-facing route (ADR-011, phase-02
 * amendment). Runs after {@link JwtAuthGuard}, which establishes _who_ the
 * caller is; this decides what they may reach.
 *
 * **Deny by default.** A route that declares no scope is refused rather than
 * allowed, and `route-audit.spec.ts` fails the build for it — an endpoint
 * added later cannot become world-readable by omission.
 */
@Injectable()
export class CompanyMembershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolution: CompanyResolutionService,
    private readonly membership: MembershipService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const identifiers = getCurrentUserIdentifiers(request);
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, targets)) {
      if (!this.membership.isAdmin(identifiers)) {
        throw new ForbiddenException('Administrator access required');
      }
      return true;
    }

    // The reason is not read here — it exists so the exemption has to be
    // argued in the source, and so the route audit can print it.
    if (this.reflector.getAllAndOverride<string>(NO_COMPANY_SCOPE, targets)) {
      return true;
    }

    const specs = this.reflector.getAllAndOverride<CompanyScopeSpec[]>(
      COMPANY_SCOPE,
      targets,
    );
    if (!specs) {
      throw new InternalServerErrorException(
        `CompanyMembershipGuard: ${context.getClass().name}.${context.getHandler().name} declares no company scope`,
      );
    }

    const companyId = await this.resolution.resolve(request, specs);
    if (companyId === null) {
      const message = this.reflector.getAllAndOverride<string>(
        COMPANY_SCOPE_MISSING_MESSAGE,
        targets,
      );
      // No declared message means the route always names a company, so a
      // request that doesn't is refused rather than explained.
      if (message) throw new BadRequestException(message);
      throw new ForbiddenException(
        'This request does not identify a company you may reach',
      );
    }

    // Administrators reach every company: the CLI operator administers the
    // system without necessarily being a member of what they administer.
    if (this.membership.isAdmin(identifiers)) return true;

    if (!(await this.membership.isMember(identifiers, companyId))) {
      // The resolved id is deliberately not echoed: the caller may have named
      // the company by slug, and repeating its UUID back would turn every
      // refusal into a slug-to-id oracle for companies they cannot see.
      throw new ForbiddenException(
        'You are not a member of the company this request targets',
      );
    }
    return true;
  }
}
