import {
  AuditEventType,
  emptyCompanyStats,
  TcpCompany,
  WireEvent,
} from '@tcp/shared';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { UUID } from 'crypto';
import { firstValueFrom, Subject, take, toArray } from 'rxjs';
import type { Request, Response } from 'express';
import { MembershipService } from '../auth/membership.service';
import { DbService } from '../db/db.service';
import { CompanyEventService } from '../events/company-event.service';
import { CompanyController } from './api.company.controller';
import { CompanyPrimingService } from './company-priming.service';
import { CompanyStatsService } from './company-stats.service';
import { ApiService } from './api.service';

const fakeReq = (user: Record<string, unknown> = { sub: 'alice' }): Request =>
  ({ user }) as unknown as Request;

const fakeRes = (): Response =>
  ({ setHeader: jest.fn() }) as unknown as Response;

const fakeCompany = {
  id: randomUUID(),
  slug: 'acme',
  name: 'Acme',
  description: 'A Company That Makes Everything',
  companyContext: 'We build widgets.',
  mcpServerList: [],
} as never;

const makeApiService = (): jest.Mocked<
  Pick<ApiService, 'createCompany' | 'setCompany' | 'getCompany'>
> => ({
  createCompany: jest.fn().mockResolvedValue(fakeCompany),
  setCompany: jest.fn().mockResolvedValue(fakeCompany),
  getCompany: jest.fn().mockResolvedValue(null),
});

const makeDbService = (): jest.Mocked<
  Pick<
    DbService,
    | 'listRoles'
    | 'listCompanies'
    | 'getCompany'
    | 'findRoleByIdOrSlug'
    | 'setRole'
    | 'deleteCompany'
    | 'deleteRole'
  >
> => ({
  listRoles: jest.fn().mockResolvedValue([]),
  listCompanies: jest.fn().mockResolvedValue([]),
  getCompany: jest.fn().mockResolvedValue(null),
  findRoleByIdOrSlug: jest.fn().mockResolvedValue(null),
  setRole: jest.fn(),
  deleteCompany: jest.fn().mockResolvedValue(true),
  deleteRole: jest.fn().mockResolvedValue(true),
});

const makeStatsService = (): jest.Mocked<
  Pick<CompanyStatsService, 'listStats'>
> => ({
  listStats: jest.fn().mockResolvedValue(new Map()),
});

const makePrimingService = (): jest.Mocked<
  Pick<CompanyPrimingService, 'prime'>
> => ({
  prime: jest.fn().mockResolvedValue([]),
});

/** Admin by default; individual tests flip it to exercise the ?all=true gate. */
const makeMembershipService = (): jest.Mocked<
  Pick<MembershipService, 'isAdmin' | 'isMember'>
> => ({
  isAdmin: jest.fn().mockReturnValue(true),
  isMember: jest.fn().mockResolvedValue(true),
});

const makeCompanyEventService = (): jest.Mocked<
  Pick<CompanyEventService, 'emit' | 'observe'>
> => ({
  emit: jest.fn(),
  observe: jest.fn().mockReturnValue(new Subject<WireEvent>()),
});

describe('CompanyController', () => {
  let api: ReturnType<typeof makeApiService>;
  let db: ReturnType<typeof makeDbService>;
  let stats: ReturnType<typeof makeStatsService>;
  let priming: ReturnType<typeof makePrimingService>;
  let companyEvents: ReturnType<typeof makeCompanyEventService>;
  let membership: ReturnType<typeof makeMembershipService>;
  let controller: CompanyController;

  beforeEach(() => {
    api = makeApiService();
    db = makeDbService();
    stats = makeStatsService();
    priming = makePrimingService();
    companyEvents = makeCompanyEventService();
    membership = makeMembershipService();
    controller = new CompanyController(
      api as unknown as ApiService,
      db as unknown as DbService,
      stats as unknown as CompanyStatsService,
      priming as unknown as CompanyPrimingService,
      companyEvents as unknown as CompanyEventService,
      membership as unknown as MembershipService,
    );
  });

  describe('postCompany', () => {
    it('calls apiService.createCompany with the template, slug, and creator identity', async () => {
      await controller.postCompany(
        {
          name: 'Acme Corp',
          slug: 'acme',
          description: 'A Company That Makes Everything',
        },
        fakeReq({ sub: 'alice', email: 'alice@example.com' }),
        fakeRes(),
      );
      expect(api.createCompany).toHaveBeenCalledWith(
        {
          name: 'Acme Corp',
          description: 'A Company That Makes Everything',
          mcpServerList: [],
        },
        'acme',
        'alice',
        'alice@example.com',
      );
    });

    it('falls back to "unknown" when the token has no sub claim', async () => {
      await controller.postCompany(
        {
          name: 'Acme Corp',
          slug: 'acme',
          description: 'A Company That Makes Everything',
        },
        fakeReq({}),
        fakeRes(),
      );
      expect(api.createCompany).toHaveBeenCalledWith(
        expect.anything(),
        'acme',
        'unknown',
        null,
      );
    });

    it('resolves without throwing', async () => {
      await expect(
        controller.postCompany(
          {
            name: 'Acme',
            slug: 'acme',
            description: 'A Company That Makes Everything',
          },
          fakeReq(),
          fakeRes(),
        ),
      ).resolves.not.toThrow();
    });
  });

  describe('putCompany', () => {
    it('calls apiService.setCompany with the path id and partial body', async () => {
      const id = randomUUID();
      const partial = { slug: 'acme', name: 'Acme' };
      await controller.putCompany(id, partial, fakeRes());
      expect(api.setCompany).toHaveBeenCalledWith(id, partial);
    });

    it('allows a partial body with only some fields', async () => {
      const id = randomUUID();
      await controller.putCompany(id, { name: 'Updated Name' }, fakeRes());
      expect(api.setCompany).toHaveBeenCalledWith(id, { name: 'Updated Name' });
    });

    it('allows patching a nested llmConfig field', async () => {
      const id = randomUUID();
      const partial = {
        llmConfig: { provider: 'openai', model: 'gpt-4o-mini' },
      };
      await controller.putCompany(id, partial, fakeRes());
      expect(api.setCompany).toHaveBeenCalledWith(id, partial);
    });
  });

  describe('getCompany', () => {
    it('calls apiService.getCompany with the provided id', async () => {
      const id = randomUUID();
      await controller.getCompany(id);
      expect(api.getCompany).toHaveBeenCalledWith(id);
    });

    it('returns the result from apiService.getCompany', async () => {
      const id = randomUUID();
      const fakeCompany = {
        id,
        slug: 'acme',
        name: 'Acme',
        description: 'A Company That Makes Everything',
        mcpServerList: [],
        nextTaskShortcodeIndex: 0,
      };
      api.getCompany.mockResolvedValue(fakeCompany);

      const result = await controller.getCompany(id);
      expect(result).toBe(fakeCompany);
    });

    it('returns null when apiService.getCompany returns null', async () => {
      api.getCompany.mockResolvedValue(null);
      const result = await controller.getCompany(randomUUID());
      expect(result).toBeNull();
    });
  });

  describe('listCompanies', () => {
    const company = (id: UUID): TcpCompany => ({
      id,
      slug: 'acme',
      name: 'Acme',
      description: 'A Company That Makes Everything',
      mcpServerList: [],
      nextTaskShortcodeIndex: 0,
    });

    it('scopes to the caller’s identifiers by default', async () => {
      await controller.listCompanies(
        fakeReq({ sub: 'alice', email: 'alice@example.com' }),
      );
      expect(db.listCompanies).toHaveBeenCalledWith([
        'alice',
        'alice@example.com',
      ]);
    });

    // A malformed flag must never widen scope — only `?all=true` and a bare
    // `?all` mean "every company".
    it.each([
      ['true', undefined],
      ['', undefined],
    ])(
      'is unscoped for ?all=%p, for an administrator',
      async (all, expected) => {
        await controller.listCompanies(fakeReq(), all);
        expect(db.listCompanies).toHaveBeenCalledWith(expected);
      },
    );

    // Refused, not quietly downgraded to the scoped list: a caller who cannot
    // see every company should be told so, not handed a different answer.
    it.each(['true', ''])(
      'refuses ?all=%p for a caller who is not an administrator',
      async (all) => {
        membership.isAdmin.mockReturnValue(false);
        await expect(
          controller.listCompanies(fakeReq({ sub: 'alice' }), all),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(db.listCompanies).not.toHaveBeenCalled();
      },
    );

    it.each(['false', 'yes'])('stays scoped for ?all=%p', async (all) => {
      membership.isAdmin.mockReturnValue(false);
      await controller.listCompanies(fakeReq({ sub: 'alice' }), all);
      expect(db.listCompanies).toHaveBeenCalledWith(['alice']);
    });

    it('merges each company’s stats onto its row', async () => {
      const withStats = randomUUID();
      const withoutStats = randomUUID();
      db.listCompanies.mockResolvedValue([
        company(withStats),
        company(withoutStats),
      ]);
      const populated = { ...emptyCompanyStats(), activeAgents: 3 };
      stats.listStats.mockResolvedValue(new Map([[withStats, populated]]));

      const result = await controller.listCompanies(fakeReq());

      expect(stats.listStats).toHaveBeenCalledWith([withStats, withoutStats]);
      expect(result[0].stats).toEqual(populated);
      // A company the stats query returned nothing for still gets a stat set.
      expect(result[1].stats).toEqual(emptyCompanyStats());
    });
  });

  describe('listRoles', () => {
    it('resolves the company by ID or slug, then delegates to dbService.listRoles', async () => {
      const id = randomUUID();
      db.getCompany.mockResolvedValue({ id } as never);

      await controller.listRoles('acme-slug');
      expect(db.getCompany).toHaveBeenCalledWith('acme-slug');
      expect(db.listRoles).toHaveBeenCalledWith(id);
    });

    it('throws NotFoundException when the company does not resolve', async () => {
      db.getCompany.mockResolvedValue(null);
      await expect(controller.listRoles('no-such-co')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getRoleBySlug', () => {
    it('resolves the company then delegates to findRoleByIdOrSlug', async () => {
      const companyId = randomUUID();
      const role = { id: randomUUID(), slug: 'analyst' };
      db.getCompany.mockResolvedValue({ id: companyId } as never);
      db.findRoleByIdOrSlug.mockResolvedValue(role as never);

      const result = await controller.getRoleBySlug('acme-slug', 'analyst');
      expect(db.getCompany).toHaveBeenCalledWith('acme-slug');
      expect(db.findRoleByIdOrSlug).toHaveBeenCalledWith(companyId, 'analyst');
      expect(result).toBe(role);
    });

    it('throws NotFoundException when the role does not resolve', async () => {
      db.getCompany.mockResolvedValue({ id: randomUUID() } as never);
      db.findRoleByIdOrSlug.mockResolvedValue(null);
      await expect(
        controller.getRoleBySlug('acme', 'no-such-role'),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the company does not resolve', async () => {
      db.getCompany.mockResolvedValue(null);
      await expect(
        controller.getRoleBySlug('no-such-co', 'analyst'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('putRoleBySlug', () => {
    it('resolves the company, then delegates to setRole with the resolved companyId', async () => {
      const companyId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId } as never);
      db.setRole.mockResolvedValue({
        id: randomUUID(),
        knowledgeDomains: ['finance'],
        rolePrompt: 'You are a careful analyst.',
      } as never);

      await controller.putRoleBySlug(
        'acme-slug',
        'analyst',
        { name: 'Updated' },
        fakeRes(),
      );
      expect(db.setRole).toHaveBeenCalledWith(
        { name: 'Updated', companyId },
        { slug: 'analyst' },
      );
    });
  });

  describe('streamCompanyEvents', () => {
    it('resolves the company, replays the priming events, then relays live ones', async () => {
      const companyId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId } as never);
      const primed: WireEvent = {
        type: 'audit',
        event: {
          timestamp: new Date().toISOString(),
          companyId,
          role: 'system',
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: { entity: 'company', reason: 'replay' },
        },
      };
      priming.prime.mockResolvedValue([primed]);
      const live = new Subject<WireEvent>();
      companyEvents.observe.mockReturnValue(live);

      const resultPromise = firstValueFrom(
        controller.streamCompanyEvents('acme-slug').pipe(take(2), toArray()),
      );
      // Let the priming chain's awaits resolve before the live event arrives.
      await new Promise((resolve) => setTimeout(resolve, 10));
      live.next({
        type: 'audit',
        event: {
          timestamp: new Date().toISOString(),
          companyId,
          role: 'system',
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: { entity: 'company', reason: 'updated' },
        },
      });

      const results = await resultPromise;
      expect(db.getCompany).toHaveBeenCalledWith('acme-slug');
      expect(priming.prime).toHaveBeenCalledWith(companyId);
      expect(companyEvents.observe).toHaveBeenCalledWith(companyId);
      // Primed rows first, then the live one. Which rows priming produces is
      // CompanyPrimingService's own spec.
      const reasons = results.map((r) => {
        const wire = r.data as WireEvent;
        return wire.type === 'audit' ? wire.event.payload.reason : wire.type;
      });
      expect(reasons).toEqual(['replay', 'updated']);
    });

    it('throws NotFoundException when the company does not resolve', async () => {
      db.getCompany.mockResolvedValue(null);
      await expect(
        firstValueFrom(controller.streamCompanyEvents('no-such-co')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteCompany', () => {
    it('resolves the company then delegates to dbService.deleteCompany', async () => {
      const companyId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId } as never);

      await controller.deleteCompany('acme-slug');
      expect(db.getCompany).toHaveBeenCalledWith('acme-slug');
      expect(db.deleteCompany).toHaveBeenCalledWith(companyId);
    });

    it('throws NotFoundException when the company does not resolve', async () => {
      db.getCompany.mockResolvedValue(null);
      await expect(controller.deleteCompany('no-such-co')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteRoleBySlug', () => {
    it('resolves the company and role, then delegates to dbService.deleteRole', async () => {
      const companyId = randomUUID();
      const roleId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId } as never);
      db.findRoleByIdOrSlug.mockResolvedValue({ id: roleId } as never);

      await controller.deleteRoleBySlug('acme-slug', 'analyst');
      expect(db.findRoleByIdOrSlug).toHaveBeenCalledWith(companyId, 'analyst');
      expect(db.deleteRole).toHaveBeenCalledWith(roleId);
    });

    it('throws NotFoundException when the role does not resolve', async () => {
      db.getCompany.mockResolvedValue({ id: randomUUID() } as never);
      db.findRoleByIdOrSlug.mockResolvedValue(null);
      await expect(
        controller.deleteRoleBySlug('acme', 'no-such-role'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
