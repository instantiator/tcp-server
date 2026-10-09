import { TcpCompany, TcpNotification } from '@tcp/shared';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IsNull, QueryFailedError, Repository } from 'typeorm';
import { CompanyEventService } from '../events/company-event.service';
import { NotificationService } from './notification.service';

/** A Postgres unique violation, as TypeORM surfaces it. */
const uniqueViolation = (): QueryFailedError =>
  new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('dup'), { code: '23505' }),
  );

const notice = (overrides: Partial<TcpNotification> = {}): TcpNotification => ({
  id: randomUUID(),
  severity: 'warning',
  kind: 'spend_threshold',
  message: 'anthropic is at 80% of its monthly cap',
  createdAt: new Date(),
  ...overrides,
});

describe('NotificationService', () => {
  // `create`/`save` are overloaded, which `jest.Mocked<Pick<…>>` can't model.
  let repo: {
    create: jest.Mock<TcpNotification, [Partial<TcpNotification>]>;
    save: jest.Mock<Promise<TcpNotification>, [TcpNotification]>;
    find: jest.Mock<Promise<TcpNotification[]>, [unknown]>;
    findOneBy: jest.Mock<Promise<TcpNotification | null>, [unknown]>;
  };
  let companyRepo: jest.Mocked<Pick<Repository<TcpCompany>, 'find'>>;
  let companyEvents: jest.Mocked<Pick<CompanyEventService, 'emit'>>;
  let service: NotificationService;
  const companyIds = [randomUUID(), randomUUID()];

  beforeEach(() => {
    repo = {
      create: jest.fn(
        (input: Partial<TcpNotification>) => ({ ...input }) as TcpNotification,
      ),
      save: jest.fn((row: TcpNotification) => Promise.resolve(row)),
      find: jest.fn((_options: unknown) =>
        Promise.resolve<TcpNotification[]>([]),
      ),
      findOneBy: jest.fn((_where: unknown) =>
        Promise.resolve<TcpNotification | null>(null),
      ),
    };
    companyRepo = {
      find: jest
        .fn()
        .mockResolvedValue(companyIds.map((id) => ({ id }) as TcpCompany)),
    };
    companyEvents = { emit: jest.fn() };
    service = new NotificationService(
      repo as unknown as Repository<TcpNotification>,
      companyRepo as unknown as Repository<TcpCompany>,
      companyEvents as unknown as CompanyEventService,
    );
  });

  describe('create', () => {
    it('saves the notification and broadcasts it to every company', async () => {
      const saved = await service.create({
        severity: 'warning',
        kind: 'spend_threshold',
        message: 'hello',
      });

      expect(saved?.message).toBe('hello');
      const calls = companyEvents.emit.mock.calls;
      expect(calls.map(([companyId]) => companyId)).toEqual(companyIds);
      for (const [companyId, event] of calls) {
        expect(event.type === 'audit' && event.event.companyId).toBe(companyId);
        expect(event.type === 'audit' && event.event.payload).toEqual({
          entity: 'notification',
          newStatus: 'active',
          reason: 'change',
          summary: saved,
        });
      }
    });

    // Another company must never see it, even live.
    it("sends a company's own notice to that company alone", async () => {
      await service.create({
        severity: 'error',
        kind: 'task_failed',
        message: 'Task 003 failed.',
        companyId: companyIds[1],
      });

      expect(companyRepo.find).not.toHaveBeenCalled();
      expect(companyEvents.emit.mock.calls.map(([id]) => id)).toEqual([
        companyIds[1],
      ]);
    });

    it('returns null and broadcasts nothing when the dedupe key was already used', async () => {
      repo.save.mockRejectedValueOnce(uniqueViolation());

      const saved = await service.create({
        severity: 'error',
        kind: 'spend_reached',
        message: 'cap reached',
        dedupeKey: 'cap:anthropic:month:2026-10-01:100',
      });

      expect(saved).toBeNull();
      expect(companyEvents.emit).not.toHaveBeenCalled();
    });

    it('rethrows a unique violation when no dedupe key was given', async () => {
      repo.save.mockRejectedValueOnce(uniqueViolation());
      await expect(
        service.create({ severity: 'info', kind: 'spend_reset', message: 'x' }),
      ).rejects.toBeInstanceOf(QueryFailedError);
    });

    it('rethrows any other database error', async () => {
      repo.save.mockRejectedValueOnce(new Error('connection lost'));
      await expect(
        service.create({
          severity: 'info',
          kind: 'spend_reset',
          message: 'x',
          dedupeKey: 'k',
        }),
      ).rejects.toThrow('connection lost');
    });
  });

  describe('list', () => {
    it('returns only active notifications by default, newest first', async () => {
      await service.list();
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [{ companyId: IsNull(), dismissedAt: IsNull() }],
          order: { createdAt: 'DESC' },
        }),
      );
    });

    it('includes dismissed notifications on request', async () => {
      await service.list(true);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: [{ companyId: IsNull() }] }),
      );
    });
  });

  describe('listForCompany', () => {
    it("returns the application-wide notices plus that company's own, and no other's", async () => {
      await service.listForCompany(companyIds[0]);
      expect(repo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: [
            { companyId: IsNull(), dismissedAt: IsNull() },
            { companyId: companyIds[0], dismissedAt: IsNull() },
          ],
        }),
      );
    });
  });

  describe('dismiss', () => {
    it('stamps dismissedAt and broadcasts the dismissal', async () => {
      const row = notice();
      repo.findOneBy.mockResolvedValue(row);

      const dismissed = await service.dismiss(row.id);

      expect(dismissed.dismissedAt).toBeInstanceOf(Date);
      const [, event] = companyEvents.emit.mock.calls[0];
      expect(event.type === 'audit' && event.event.payload.newStatus).toBe(
        'dismissed',
      );
    });

    it('is idempotent: an already-dismissed notification is returned unchanged', async () => {
      const dismissedAt = new Date('2026-01-01T00:00:00.000Z');
      repo.findOneBy.mockResolvedValue(notice({ dismissedAt }));

      const result = await service.dismiss(randomUUID());

      expect(result.dismissedAt).toBe(dismissedAt);
      expect(repo.save).not.toHaveBeenCalled();
      expect(companyEvents.emit).not.toHaveBeenCalled();
    });

    it('404s for an unknown notification', async () => {
      repo.findOneBy.mockResolvedValue(null);
      await expect(service.dismiss(randomUUID())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
