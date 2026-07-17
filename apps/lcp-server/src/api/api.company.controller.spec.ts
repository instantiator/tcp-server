import { CompanyEvent } from '@lcp/shared';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { firstValueFrom, Subject, take, toArray } from 'rxjs';
import type { Request, Response } from 'express';
import { DbService } from '../db/db.service';
import { CompanyEventService } from '../events/company-event.service';
import { CompanyController } from './api.company.controller';
import { ApiService } from './api.service';
import { TaskService } from './task.service';

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

const makeTaskService = (): jest.Mocked<
  Pick<TaskService, 'listChangeSummaries'>
> => ({
  listChangeSummaries: jest.fn().mockResolvedValue([]),
});

const makeCompanyEventService = (): jest.Mocked<
  Pick<CompanyEventService, 'emit' | 'observe'>
> => ({
  emit: jest.fn(),
  observe: jest.fn().mockReturnValue(new Subject<CompanyEvent>()),
});

describe('CompanyController', () => {
  let api: ReturnType<typeof makeApiService>;
  let db: ReturnType<typeof makeDbService>;
  let tasks: ReturnType<typeof makeTaskService>;
  let companyEvents: ReturnType<typeof makeCompanyEventService>;
  let controller: CompanyController;

  beforeEach(() => {
    api = makeApiService();
    db = makeDbService();
    tasks = makeTaskService();
    companyEvents = makeCompanyEventService();
    controller = new CompanyController(
      api as unknown as ApiService,
      db as unknown as DbService,
      tasks as unknown as TaskService,
      companyEvents as unknown as CompanyEventService,
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
    it('delegates to dbService.listCompanies and returns the result', async () => {
      const companies = [
        {
          id: randomUUID(),
          slug: 'acme',
          name: 'Acme',
          description: 'A Company That Makes Everything',
          mcpServerList: [],
          nextTaskShortcodeIndex: 0,
        },
      ];
      db.listCompanies.mockResolvedValue(companies);

      const result = await controller.listCompanies();
      expect(db.listCompanies).toHaveBeenCalledTimes(1);
      expect(result).toBe(companies);
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
    it('resolves the company, primes company_changed + each task_changed, then relays live events', async () => {
      const companyId = randomUUID();
      db.getCompany.mockResolvedValue({ id: companyId } as never);
      const taskSummary = {
        id: randomUUID(),
        status: 'ready' as const,
        request: 'Write a report',
        shortcode: '000',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        completedSteps: 0,
        totalSteps: 0,
      };
      tasks.listChangeSummaries.mockResolvedValue([taskSummary]);
      const live = new Subject<CompanyEvent>();
      companyEvents.observe.mockReturnValue(live);

      const resultPromise = firstValueFrom(
        controller.streamCompanyEvents('acme-slug').pipe(take(3), toArray()),
      );
      // Let the priming chain's awaits resolve before the live event arrives.
      await new Promise((resolve) => setTimeout(resolve, 10));
      live.next({
        timestamp: new Date().toISOString(),
        kind: 'company_changed',
        data: { companyId },
      });

      const results = await resultPromise;
      expect(db.getCompany).toHaveBeenCalledWith('acme-slug');
      expect(tasks.listChangeSummaries).toHaveBeenCalledWith(companyId);
      expect(companyEvents.observe).toHaveBeenCalledWith(companyId);
      expect(results.map((r) => (r.data as CompanyEvent).kind)).toEqual([
        'company_changed',
        'task_changed',
        'company_changed',
      ]);
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
