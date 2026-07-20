import {
  CompanyUser,
  Conversation,
  ConversationMessage,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { ConversationService } from './conversation.service';

const makeRepo = <T extends object>(): jest.Mocked<
  Pick<
    Repository<T>,
    'find' | 'findOne' | 'findBy' | 'findOneBy' | 'create' | 'save'
  >
> => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findBy: jest.fn().mockResolvedValue([]),
  findOneBy: jest.fn().mockResolvedValue(null),
  create: jest.fn().mockImplementation((d) => d as T),
  save: jest.fn().mockImplementation((e) => Promise.resolve(e as T)),
});

const makeDataSource = (overrides?: {
  queryResult?: unknown[];
}): {
  options: { type: string };
  query: jest.Mock;
  transaction: jest.Mock;
} => ({
  options: { type: 'postgres' },
  // The postgres driver resolves a non-SELECT query to [rows, affectedRowCount].
  query: jest
    .fn()
    .mockResolvedValue(overrides?.queryResult ?? [[{ queryIndex: 1 }], 1]),
  transaction: jest
    .fn()
    .mockImplementation((fn: (em: EntityManager) => Promise<unknown>) => {
      const em = {
        getRepository: jest.fn().mockReturnValue(makeRepo()),
      } as unknown as EntityManager;
      return fn(em);
    }),
});

describe('ConversationService', () => {
  let convRepo: ReturnType<typeof makeRepo<Conversation>>;
  let msgRepo: ReturnType<typeof makeRepo<ConversationMessage>>;
  let userRepo: ReturnType<typeof makeRepo<CompanyUser>>;
  let roleRepo: ReturnType<typeof makeRepo<LcpRole>>;
  let companyRepo: ReturnType<typeof makeRepo<LcpCompany>>;
  let dataSource: ReturnType<typeof makeDataSource>;
  let service: ConversationService;

  const companyId = randomUUID();
  const roleId = randomUUID();
  const agentId = randomUUID();

  beforeEach(() => {
    convRepo = makeRepo();
    msgRepo = makeRepo();
    userRepo = makeRepo();
    roleRepo = makeRepo();
    companyRepo = makeRepo();
    dataSource = makeDataSource();
    service = new ConversationService(
      convRepo as unknown as Repository<Conversation>,
      msgRepo as unknown as Repository<ConversationMessage>,
      userRepo as unknown as Repository<CompanyUser>,
      roleRepo as unknown as Repository<LcpRole>,
      companyRepo as unknown as Repository<LcpCompany>,
      dataSource as unknown as DataSource,
    );
  });

  describe('list', () => {
    it('calls find with companyId and status filters when provided', async () => {
      await service.list(companyId, 'awaiting_user');
      expect(convRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId, status: 'awaiting_user' },
        }),
      );
    });

    it('calls find with empty where when no filters provided', async () => {
      await service.list();
      expect(convRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('get', () => {
    it('throws NotFoundException when slug not found', async () => {
      convRepo.findOne.mockResolvedValue(null);
      await expect(service.get('unknown-0')).rejects.toThrow(NotFoundException);
    });

    it('returns conversation and messages', async () => {
      const conv = {
        id: randomUUID(),
        slug: 'analyst-1',
        companyId,
      } as Conversation;
      convRepo.findOne.mockResolvedValue(conv);
      msgRepo.find.mockResolvedValue([]);
      companyRepo.findOneBy.mockResolvedValue(null);

      const result = await service.get('analyst-1');
      expect(result.conversation).toBe(conv);
      expect(result.messages).toEqual([]);
      expect(result.companyTimezone).toBeNull();
    });

    it('includes the owning company timezone when set', async () => {
      const conv = {
        id: randomUUID(),
        slug: 'analyst-1',
        companyId,
      } as Conversation;
      convRepo.findOne.mockResolvedValue(conv);
      msgRepo.find.mockResolvedValue([]);
      companyRepo.findOneBy.mockResolvedValue({
        timezone: 'Europe/London',
      } as LcpCompany);

      const result = await service.get('analyst-1');
      expect(result.companyTimezone).toBe('Europe/London');
    });
  });

  describe('create', () => {
    it('generates slug from roleName and incremented queryIndex', async () => {
      dataSource.query.mockResolvedValue([[{ queryIndex: 3 }], 1]);
      userRepo.findBy.mockResolvedValue([]);

      await service.create(
        companyId,
        roleId,
        'Chief Analyst',
        agentId,
        'What is the plan?',
      );

      expect(convRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'chief-analyst-3' }),
      );
    });

    it('increments queryIndex via raw SQL for the role', async () => {
      userRepo.findBy.mockResolvedValue([]);
      await service.create(companyId, roleId, 'cto', agentId, 'question');

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE lcp_role'),
        [roleId],
      );
    });

    it('routes to explicit userIds when given, skipping routeQuery', async () => {
      const targetId = randomUUID();
      userRepo.findBy.mockResolvedValue([
        { id: targetId, identifier: 'alice@example.com' } as CompanyUser,
      ]);

      const conv = await service.create(
        companyId,
        roleId,
        'cto',
        agentId,
        'question',
        undefined,
        [targetId],
      );

      expect(conv.routedToIdentifiers).toEqual(['alice@example.com']);
    });

    it('throws BadRequestException when a userId does not belong to the company', async () => {
      const targetId = randomUUID();
      userRepo.findBy.mockResolvedValue([]); // none match

      await expect(
        service.create(
          companyId,
          roleId,
          'cto',
          agentId,
          'question',
          undefined,
          [targetId],
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('routeQuery', () => {
    const makeUser = (
      identifier: string,
      memberType: CompanyUser['memberType'],
      roles: string[],
      knowledgeDomains: string[],
    ): CompanyUser =>
      ({ identifier, memberType, roles, knowledgeDomains }) as CompanyUser;

    it('matches users whose knowledgeDomain appears in the question', async () => {
      userRepo.findBy.mockResolvedValue([
        makeUser('alice@example.com', 'member', [], ['finance']),
        makeUser('bob@example.com', 'member', [], ['legal']),
      ]);

      const result = await service.routeQuery(
        companyId,
        'Finance report needed',
        'analyst',
      );
      expect(result).toEqual(['alice@example.com']);
    });

    it('matches users whose role appears in the question', async () => {
      userRepo.findBy.mockResolvedValue([
        makeUser('alice@example.com', 'member', ['analyst'], []),
      ]);

      const result = await service.routeQuery(
        companyId,
        'The analyst should review this',
        'cto',
      );
      expect(result).toEqual(['alice@example.com']);
    });

    it('falls back to owners when no member matches', async () => {
      userRepo.findBy.mockResolvedValue([
        makeUser('alice@example.com', 'member', [], ['legal']),
        makeUser('bob@example.com', 'owner', [], []),
      ]);

      const result = await service.routeQuery(
        companyId,
        'Unrelated question',
        'cto',
      );
      expect(result).toEqual(['bob@example.com']);
    });

    it('falls back to all users when no owners exist', async () => {
      userRepo.findBy.mockResolvedValue([
        makeUser('alice@example.com', 'member', [], []),
        makeUser('bob@example.com', 'member', [], []),
      ]);

      const result = await service.routeQuery(
        companyId,
        'Unrelated question',
        'cto',
      );
      expect(result).toEqual(['alice@example.com', 'bob@example.com']);
    });

    it('returns empty array when company has no users', async () => {
      userRepo.findBy.mockResolvedValue([]);
      const result = await service.routeQuery(companyId, 'anything', 'cto');
      expect(result).toEqual([]);
    });
  });

  describe('reply', () => {
    it('throws NotFoundException when slug not found in transaction', async () => {
      // Make the transaction's em.getRepository(Conversation).findOne return null
      dataSource.transaction.mockImplementation(
        (fn: (em: EntityManager) => Promise<unknown>) => {
          const em = {
            getRepository: jest.fn().mockReturnValue({
              findOne: jest.fn().mockResolvedValue(null),
              create: jest.fn(),
              save: jest.fn(),
            }),
          } as unknown as EntityManager;
          return fn(em);
        },
      );

      await expect(service.reply('unknown-0', 'content')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ConflictException when conversation is already closed', async () => {
      const conv = { slug: 'cto-1', status: 'closed' } as Conversation;
      dataSource.transaction.mockImplementation(
        (fn: (em: EntityManager) => Promise<unknown>) => {
          const em = {
            getRepository: jest.fn().mockReturnValue({
              findOne: jest.fn().mockResolvedValue(conv),
              create: jest.fn(),
              save: jest.fn(),
            }),
          } as unknown as EntityManager;
          return fn(em);
        },
      );

      await expect(service.reply('cto-1', 'late reply')).rejects.toThrow(
        ConflictException,
      );
    });
  });
});
