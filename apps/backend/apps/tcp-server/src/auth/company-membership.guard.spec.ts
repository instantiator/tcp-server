import {
  BadRequestException,
  ExecutionContext,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { CompanyMembershipGuard } from './company-membership.guard';
import { CompanyResolutionService } from './company-resolution.service';
import {
  ADMIN_ONLY,
  COMPANY_SCOPE,
  COMPANY_SCOPE_MISSING_MESSAGE,
  NO_COMPANY_SCOPE,
} from './company-scope.decorator';
import { MembershipService } from './membership.service';

const COMPANY_ID = randomUUID();

/** Metadata a route is standing in for, keyed as the decorators set it. */
type RouteMetadata = Record<string, unknown>;

const fakeContext = (
  metadata: RouteMetadata,
  user: Record<string, unknown> = { sub: 'alice', email: 'alice@example.com' },
): { context: ExecutionContext; reflector: Reflector } => {
  const handler = function route() {};
  class FakeController {}
  const context = {
    switchToHttp: () => ({
      getRequest: () => ({ user }) as unknown as Request,
    }),
    getHandler: () => handler,
    getClass: () => FakeController,
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
  return { context, reflector };
};

const makeResolution = (): jest.Mocked<
  Pick<CompanyResolutionService, 'resolve'>
> => ({
  resolve: jest.fn().mockResolvedValue(COMPANY_ID),
});

const makeMembership = (): jest.Mocked<
  Pick<MembershipService, 'isMember' | 'isAdmin'>
> => ({
  isMember: jest.fn().mockResolvedValue(true),
  isAdmin: jest.fn().mockReturnValue(false),
});

const make = (metadata: RouteMetadata, user?: Record<string, unknown>) => {
  const { context, reflector } = fakeContext(metadata, user);
  const resolution = makeResolution();
  const membership = makeMembership();
  return {
    context,
    resolution,
    membership,
    guard: new CompanyMembershipGuard(
      reflector,
      resolution as unknown as CompanyResolutionService,
      membership as unknown as MembershipService,
    ),
  };
};

const SCOPE: RouteMetadata = {
  [COMPANY_SCOPE]: [{ from: 'param', key: 'id', via: 'company' }],
};

describe('CompanyMembershipGuard', () => {
  describe('a scoped route', () => {
    it('admits a member of the resolved company', async () => {
      const { guard, context, membership } = make(SCOPE);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(membership.isMember).toHaveBeenCalledWith(
        ['alice', 'alice@example.com'],
        COMPANY_ID,
      );
    });

    it('refuses a caller who is not a member', async () => {
      const { guard, context, membership } = make(SCOPE);
      membership.isMember.mockResolvedValue(false);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    // The CLI operator administers companies they were never added to.
    it('admits an administrator without a membership row', async () => {
      const { guard, context, membership } = make(SCOPE);
      membership.isMember.mockResolvedValue(false);
      membership.isAdmin.mockReturnValue(true);
      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(membership.isMember).not.toHaveBeenCalled();
    });

    it('refuses a token carrying neither a sub nor an email', async () => {
      const { guard, context, membership } = make(SCOPE, {});
      membership.isMember.mockResolvedValue(false);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(membership.isMember).toHaveBeenCalledWith([], COMPANY_ID);
    });
  });

  describe('when the request names no company', () => {
    it('raises the route’s own 400 when it declares one', async () => {
      const { guard, context, resolution } = make({
        ...SCOPE,
        [COMPANY_SCOPE_MISSING_MESSAGE]:
          'companyId query parameter is required',
      });
      resolution.resolve.mockResolvedValue(null);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    // A route that always names a company has nothing to explain: an
    // unresolvable request there is refused, not coached.
    it('refuses outright when the route declares no message', async () => {
      const { guard, context, resolution } = make(SCOPE);
      resolution.resolve.mockResolvedValue(null);
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('an admin-only route', () => {
    it('admits an administrator', async () => {
      const { guard, context, membership } = make({ [ADMIN_ONLY]: true });
      membership.isAdmin.mockReturnValue(true);
      await expect(guard.canActivate(context)).resolves.toBe(true);
    });

    it('refuses everyone else, member or not', async () => {
      const { guard, context, resolution } = make({ [ADMIN_ONLY]: true });
      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(resolution.resolve).not.toHaveBeenCalled();
    });
  });

  it('admits an explicitly unscoped route', async () => {
    const { guard, context, resolution } = make({
      [NO_COMPANY_SCOPE]: 'names no company',
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(resolution.resolve).not.toHaveBeenCalled();
  });

  // Deny by default. `route-audit.spec.ts` catches this before it ships; the
  // guard still refuses at request time rather than falling open.
  it('refuses a route that declares nothing at all', async () => {
    const { guard, context } = make({});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});
