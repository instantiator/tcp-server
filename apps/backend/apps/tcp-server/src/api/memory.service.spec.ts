import {
  AuditEventType,
  EmbeddingService,
  EpisodicMemory,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { MemoryService } from './memory.service';

const COMPANY_ID = randomUUID();
const ROLE_ID = randomUUID();
const MEMORY_ID = randomUUID();
const EMBEDDING = { provider: 'lm-studio' as const, model: 'embed' };

const memory = (overrides: Partial<EpisodicMemory> = {}): EpisodicMemory => ({
  id: MEMORY_ID,
  companyId: COMPANY_ID,
  roleId: ROLE_ID,
  agentId: null,
  content: 'Tea is £3',
  tags: ['prices'],
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

function setup({
  embeddingConfig = EMBEDDING,
}: { embeddingConfig?: object | null } = {}) {
  const embedding = {
    embedTexts: jest.fn().mockResolvedValue([[0.1, 0.2]]),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const memoryRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOneBy: jest.fn().mockResolvedValue(memory()),
    findOneByOrFail: jest.fn().mockResolvedValue(memory()),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  const roleRepo = {
    findOneBy: jest
      .fn()
      .mockResolvedValue({ id: ROLE_ID, companyId: COMPANY_ID }),
  };
  const companyRepo = {
    findOneBy: jest.fn().mockResolvedValue({ id: COMPANY_ID, embeddingConfig }),
  };
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ id: MEMORY_ID }]),
  };
  const config = { get: jest.fn().mockReturnValue(undefined) };
  const service = new MemoryService(
    embedding as unknown as EmbeddingService,
    config as unknown as ConfigService,
    audit as unknown as AuditService,
    memoryRepo as unknown as Repository<EpisodicMemory>,
    roleRepo as unknown as Repository<TcpRole>,
    companyRepo as unknown as Repository<TcpCompany>,
    dataSource as unknown as DataSource,
  );
  return { service, embedding, audit, memoryRepo, roleRepo, dataSource };
}

const auditedAs = (action: string) => [
  COMPANY_ID,
  'user',
  null,
  AuditEventType.StateChange,
  {
    source: 'memory',
    action,
    roleId: ROLE_ID,
    memoryId: MEMORY_ID,
    userId: 'u1',
  },
];

describe('MemoryService', () => {
  describe('list', () => {
    it('lists the role and company only, newest first', async () => {
      const { service, memoryRepo } = setup();
      await service.list(ROLE_ID);
      expect(memoryRepo.find).toHaveBeenCalledWith({
        where: { roleId: ROLE_ID, companyId: COMPANY_ID },
        order: { updatedAt: 'DESC' },
        take: 501,
      });
    });

    it('caps at 500 and says it was truncated', async () => {
      const { service, memoryRepo } = setup();
      memoryRepo.find.mockResolvedValue(
        Array.from({ length: 501 }, () => memory({ id: randomUUID() })),
      );
      const list = await service.list(ROLE_ID);
      expect(list.memories).toHaveLength(500);
      expect(list.truncated).toBe(true);
    });

    it("can't write without an embedding model", async () => {
      const { service } = setup({ embeddingConfig: null });
      expect((await service.list(ROLE_ID)).canWrite).toBe(false);
    });

    it('404s for an unknown role', async () => {
      const { service, roleRepo } = setup();
      roleRepo.findOneBy.mockResolvedValue(null);
      await expect(service.list(ROLE_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('embeds, stores with clean tags and no agent, and audits', async () => {
      const { service, embedding, dataSource, audit } = setup();
      await service.create(
        ROLE_ID,
        { content: 'Tea is £3', tags: [' prices ', 'prices', ''] },
        'u1',
      );
      expect(embedding.embedTexts).toHaveBeenCalledWith(EMBEDDING, [
        'Tea is £3',
      ]);
      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).not.toContain('agentId');
      expect(params.slice(0, 4)).toEqual([
        COMPANY_ID,
        ROLE_ID,
        'Tea is £3',
        '["prices"]',
      ]);
      expect(audit.record).toHaveBeenCalledWith(...auditedAs('created'));
    });

    it('refuses with 422 and stores nothing without an embedding model', async () => {
      const { service, dataSource } = setup({ embeddingConfig: null });
      await expect(
        service.create(ROLE_ID, { content: 'x' }, 'u1'),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('re-embeds and bumps the version when the content changes', async () => {
      const { service, embedding, dataSource, audit } = setup();
      await service.update(ROLE_ID, MEMORY_ID, { content: 'Tea is £4' }, 'u1');
      expect(embedding.embedTexts).toHaveBeenCalledWith(EMBEDDING, [
        'Tea is £4',
      ]);
      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain('version = version + 1');
      expect(params[1]).toBe('Tea is £4');
      expect(params[2]).toBe('["prices"]');
      expect(params[3]).toEqual(expect.any(String));
      expect(audit.record).toHaveBeenCalledWith(...auditedAs('updated'));
    });

    it('keeps the embedding when only the tags change, even without a model', async () => {
      const { service, embedding, dataSource } = setup({
        embeddingConfig: null,
      });
      await service.update(ROLE_ID, MEMORY_ID, { tags: ['a'] }, 'u1');
      expect(embedding.embedTexts).not.toHaveBeenCalled();
      const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([MEMORY_ID, 'Tea is £3', '["a"]', null]);
    });

    it("looks the memory up by role and company, and 404s when it isn't there", async () => {
      const { service, memoryRepo, dataSource } = setup();
      memoryRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.update(ROLE_ID, MEMORY_ID, { content: 'x' }, 'u1'),
      ).rejects.toThrow(NotFoundException);
      expect(memoryRepo.findOneBy).toHaveBeenCalledWith({
        id: MEMORY_ID,
        roleId: ROLE_ID,
        companyId: COMPANY_ID,
      });
      expect(dataSource.query).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('removes the memory and audits', async () => {
      const { service, memoryRepo, audit } = setup();
      await service.remove(ROLE_ID, MEMORY_ID, 'u1');
      expect(memoryRepo.remove).toHaveBeenCalledWith(memory());
      expect(audit.record).toHaveBeenCalledWith(...auditedAs('deleted'));
    });
  });
});
