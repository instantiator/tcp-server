import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DEFAULT_RAG_THRESHOLD, TcpCompany, TcpRole } from '@lcp/shared';
import { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { StorageObject, StorageService } from '../storage/storage.service';
import { KnowledgeService } from './knowledge.service';

function makeRole(overrides: Partial<TcpRole> = {}): TcpRole {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    slug: 'analyst',
    name: 'analyst',
    description: 'Analyses things.',
    systemPromptTemplate: '',
    knowledgeDomains: [],
    mcpServerList: [],
    queryIndex: 0,
    company: {} as never,
    ...overrides,
  };
}

function makeCompany(overrides: Partial<TcpCompany> = {}): TcpCompany {
  return {
    id: randomUUID(),
    slug: 'acme',
    name: 'ACME',
    description: 'Test company',
    mcpServerList: [],
    nextTaskShortcodeIndex: 0,
    ...overrides,
  };
}

function makeStorageObject(name: string, dir = 'analyst'): StorageObject {
  return {
    key: `acme/knowledge/${dir}/${name}`,
    name,
    size: 100,
    lastModified: new Date('2025-01-01'),
  };
}

describe('KnowledgeService', () => {
  let service: KnowledgeService;
  let storage: {
    listKnowledgeFiles: jest.Mock;
    putKnowledgeFile: jest.Mock;
    getKnowledgeFile: jest.Mock;
    deleteKnowledgeFile: jest.Mock;
  };
  let reindex: { bumpCompany: jest.Mock; isRebuilding: jest.Mock };
  let ragRetrieval: { retrieve: jest.Mock };
  let config: { get: jest.Mock };
  let roleRepo: { findOneBy: jest.Mock; findBy: jest.Mock };
  let companyRepo: { findOneBy: jest.Mock };
  let chunkRepo: { count: jest.Mock };
  let stateRepo: { findOne: jest.Mock };

  const role = makeRole();
  const company = makeCompany({ id: role.companyId });

  beforeEach(() => {
    storage = {
      listKnowledgeFiles: jest.fn().mockResolvedValue([]),
      putKnowledgeFile: jest
        .fn()
        .mockResolvedValue('acme/knowledge/analyst/report.md'),
      getKnowledgeFile: jest.fn().mockResolvedValue(null),
      deleteKnowledgeFile: jest.fn().mockResolvedValue(undefined),
    };
    reindex = {
      bumpCompany: jest.fn().mockResolvedValue(undefined),
      isRebuilding: jest.fn().mockResolvedValue(false),
    };
    ragRetrieval = { retrieve: jest.fn().mockResolvedValue([]) };
    config = { get: jest.fn().mockReturnValue(undefined) };
    roleRepo = {
      findOneBy: jest.fn().mockResolvedValue(role),
      findBy: jest.fn().mockResolvedValue([role]),
    };
    companyRepo = { findOneBy: jest.fn().mockResolvedValue(company) };
    chunkRepo = { count: jest.fn().mockResolvedValue(0) };
    stateRepo = { findOne: jest.fn().mockResolvedValue(null) };

    service = new KnowledgeService(
      storage as unknown as StorageService,
      reindex as unknown as KnowledgeReindexService,
      ragRetrieval as never,
      config as never,
      roleRepo as never,
      companyRepo as never,
      chunkRepo as never,
      stateRepo as never,
    );
  });

  describe('list (role scope)', () => {
    it('returns mapped summaries from storage, scoped by role slug', async () => {
      storage.listKnowledgeFiles.mockResolvedValue([
        makeStorageObject('report.md'),
        makeStorageObject('handbook.md'),
      ]);
      const result = await service.list({ kind: 'role', roleId: role.id });
      expect(result).toHaveLength(2);
      expect(storage.listKnowledgeFiles).toHaveBeenCalledWith({
        companySlug: 'acme',
        roleSlug: 'analyst',
      });
    });

    it('throws NotFoundException when role does not exist', async () => {
      roleRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.list({ kind: 'role', roleId: randomUUID() }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when company does not exist', async () => {
      companyRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.list({ kind: 'role', roleId: role.id }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('list (company scope)', () => {
    it('lists the shared-scope directory (roleSlug: null)', async () => {
      storage.listKnowledgeFiles.mockResolvedValue([
        makeStorageObject('policy.md', 'shared'),
      ]);
      const result = await service.list({
        kind: 'company',
        companyId: company.id,
      });
      expect(result).toHaveLength(1);
      expect(storage.listKnowledgeFiles).toHaveBeenCalledWith({
        companySlug: 'acme',
        roleSlug: null,
      });
    });

    it('resolves a company slug as well as a UUID', async () => {
      await service.list({ kind: 'company', companyId: 'acme' });
      expect(companyRepo.findOneBy).toHaveBeenCalledWith({ slug: 'acme' });
    });

    it('throws NotFoundException when the company does not exist', async () => {
      companyRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.list({ kind: 'company', companyId: 'no-such-co' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('get', () => {
    it('returns file content when found', async () => {
      storage.getKnowledgeFile.mockResolvedValue('# Report\ncontent');
      const content = await service.get(
        { kind: 'role', roleId: role.id },
        'report.md',
      );
      expect(content).toBe('# Report\ncontent');
    });

    it('throws NotFoundException when the file does not exist', async () => {
      storage.getKnowledgeFile.mockResolvedValue(null);
      await expect(
        service.get({ kind: 'role', roleId: role.id }, 'missing.md'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('store (role scope)', () => {
    it('stores in the storage layer (RAG indexing is triggered by the write hook)', async () => {
      const content = Buffer.from('# Hello\ncontent');
      const summary = await service.store(
        { kind: 'role', roleId: role.id },
        'report.md',
        content,
      );
      expect(storage.putKnowledgeFile).toHaveBeenCalledWith(
        { companySlug: 'acme', roleSlug: 'analyst' },
        'report.md',
        content,
        undefined,
      );
      expect(summary.key).toBe('acme/knowledge/analyst/report.md');
      // The service no longer indexes synchronously — the storage adapter's
      // write hook enqueues the rebuild.
      expect(reindex.bumpCompany).not.toHaveBeenCalled();
    });

    it('passes originators through to the storage layer', async () => {
      const content = Buffer.from('# Hello\ncontent');
      const originators = { user: 'user-1', agent: null, task: null };
      await service.store(
        { kind: 'role', roleId: role.id },
        'report.md',
        content,
        originators,
      );
      expect(storage.putKnowledgeFile).toHaveBeenCalledWith(
        { companySlug: 'acme', roleSlug: 'analyst' },
        'report.md',
        content,
        originators,
      );
    });
  });

  describe('store (company scope)', () => {
    it('stores under the shared scope (roleSlug: null)', async () => {
      const content = Buffer.from('# Shared\ncontent');
      storage.putKnowledgeFile.mockResolvedValue(
        'acme/knowledge/shared/policy.md',
      );
      const summary = await service.store(
        { kind: 'company', companyId: company.id },
        'policy.md',
        content,
      );
      expect(storage.putKnowledgeFile).toHaveBeenCalledWith(
        { companySlug: 'acme', roleSlug: null },
        'policy.md',
        content,
        undefined,
      );
      expect(summary.key).toBe('acme/knowledge/shared/policy.md');
    });
  });

  describe('delete', () => {
    it('deletes from storage (RAG chunks are removed by the write hook)', async () => {
      await service.delete({ kind: 'role', roleId: role.id }, 'report.md');
      expect(storage.deleteKnowledgeFile).toHaveBeenCalledWith(
        { companySlug: 'acme', roleSlug: 'analyst' },
        'report.md',
        undefined,
      );
    });

    it('is idempotent: an unknown filename does not throw', async () => {
      storage.deleteKnowledgeFile.mockRejectedValue(
        new NotFoundException('File not found'),
      );
      await expect(
        service.delete({ kind: 'role', roleId: role.id }, 'missing.md'),
      ).resolves.toBeUndefined();
    });

    it('re-throws unexpected storage errors', async () => {
      storage.deleteKnowledgeFile.mockRejectedValue(new Error('boom'));
      await expect(
        service.delete({ kind: 'role', roleId: role.id }, 'report.md'),
      ).rejects.toThrow('boom');
    });
  });

  describe('reindexCompany', () => {
    it('bumps every scope of the resolved company', async () => {
      await service.reindexCompany(company.id);
      expect(reindex.bumpCompany).toHaveBeenCalledWith(company);
    });

    it('throws NotFoundException when the company does not exist', async () => {
      companyRepo.findOneBy.mockResolvedValue(null);
      await expect(service.reindexCompany('no-such-co')).rejects.toThrow(
        NotFoundException,
      );
      expect(reindex.bumpCompany).not.toHaveBeenCalled();
    });
  });

  describe('queryRag', () => {
    it('resolves the role/company and delegates to RagRetrievalService.retrieve', async () => {
      const chunks = [
        {
          id: randomUUID(),
          documentPath: 'acme/knowledge/analyst/report.md',
          chunkIndex: 0,
          content: 'Some chunk text.',
          similarity: 0.92,
        },
      ];
      ragRetrieval.retrieve.mockResolvedValue(chunks);

      const result = await service.queryRag(role.id, 'query text', 3, 0.5);

      expect(result).toBe(chunks);
      expect(ragRetrieval.retrieve).toHaveBeenCalledWith(
        role.id,
        company.id,
        'query text',
        company.embeddingConfig,
        3,
        0.5,
      );
    });

    it('resolves the role/company threshold when the caller gives none, so the route reports what the role would really retrieve', async () => {
      await service.queryRag(role.id, 'query text');
      expect(ragRetrieval.retrieve).toHaveBeenCalledWith(
        role.id,
        company.id,
        'query text',
        company.embeddingConfig,
        undefined,
        DEFAULT_RAG_THRESHOLD,
      );
    });

    it('lets an explicit threshold win over the resolved one, so operators can probe raw scores', async () => {
      await service.queryRag(role.id, 'query text', undefined, 0);
      expect(ragRetrieval.retrieve).toHaveBeenCalledWith(
        role.id,
        company.id,
        'query text',
        company.embeddingConfig,
        undefined,
        0,
      );
    });

    it('throws NotFoundException when the role does not exist', async () => {
      roleRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.queryRag(randomUUID(), 'query text'),
      ).rejects.toThrow(NotFoundException);
      expect(ragRetrieval.retrieve).not.toHaveBeenCalled();
    });
  });

  describe('status (role scope)', () => {
    it('assembles counts, size, generation, lastIndexedAt, and indexing state', async () => {
      storage.listKnowledgeFiles.mockResolvedValue([
        makeStorageObject('report.md'),
        makeStorageObject('handbook.md'),
      ]);
      chunkRepo.count.mockResolvedValue(7);
      stateRepo.findOne.mockResolvedValue({
        generation: 3,
        fingerprint: 'abc',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      reindex.isRebuilding.mockResolvedValue(true);

      const status = await service.status({ kind: 'role', roleId: role.id });

      expect(status).toEqual({
        documentCount: 2,
        totalBytes: 200,
        chunkCount: 7,
        generation: 3,
        lastIndexedAt: '2026-01-01T00:00:00.000Z',
        indexing: true,
        lastError: null,
        lastErrorAt: null,
      });
      expect(chunkRepo.count).toHaveBeenCalledWith({
        where: { companyId: company.id, roleId: role.id },
      });
      expect(reindex.isRebuilding).toHaveBeenCalledWith(company.id, role.id);
    });

    it('reports lastIndexedAt as null when never successfully rebuilt (no fingerprint)', async () => {
      stateRepo.findOne.mockResolvedValue({
        generation: 1,
        fingerprint: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const status = await service.status({ kind: 'role', roleId: role.id });
      expect(status.lastIndexedAt).toBeNull();
      expect(status.generation).toBe(1);
    });

    it('defaults generation to 0 and lastIndexedAt to null when the scope has never been bumped', async () => {
      stateRepo.findOne.mockResolvedValue(null);
      const status = await service.status({ kind: 'role', roleId: role.id });
      expect(status.generation).toBe(0);
      expect(status.lastIndexedAt).toBeNull();
    });

    it('throws NotFoundException when the role does not exist', async () => {
      roleRepo.findOneBy.mockResolvedValue(null);
      await expect(
        service.status({ kind: 'role', roleId: randomUUID() }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('statusForCompany', () => {
    it('returns shared status plus a status entry for every role', async () => {
      storage.listKnowledgeFiles.mockResolvedValue([]);
      const status = await service.statusForCompany(company.id);

      expect(status.shared).toBeDefined();
      expect(status.roles).toHaveLength(1);
      expect(status.roles[0].roleId).toBe(role.id);
      expect(status.roles[0].roleSlug).toBe(role.slug);
      expect(status.roles[0].status.documentCount).toBe(0);
      // shared scope queried with a null roleId, role scope with the role's id
      expect(reindex.isRebuilding).toHaveBeenCalledWith(company.id, null);
      expect(reindex.isRebuilding).toHaveBeenCalledWith(company.id, role.id);
    });

    it('throws NotFoundException when the company does not exist', async () => {
      companyRepo.findOneBy.mockResolvedValue(null);
      await expect(service.statusForCompany('no-such-co')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('embeddingWarnings', () => {
    it('warns when the company has no embeddingConfig and no env fallback', async () => {
      companyRepo.findOneBy.mockResolvedValue(
        makeCompany({ id: company.id, embeddingConfig: null }),
      );
      const warnings = await service.embeddingWarnings({
        kind: 'role',
        roleId: role.id,
      });
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('No embedding config resolved'),
        ]),
      );
    });

    it('is silent when the company has its own embeddingConfig', async () => {
      companyRepo.findOneBy.mockResolvedValue(
        makeCompany({
          id: company.id,
          embeddingConfig: { provider: 'lm-studio', model: 'embed' },
        }),
      );
      const warnings = await service.embeddingWarnings({
        kind: 'role',
        roleId: role.id,
      });
      expect(warnings).toEqual([]);
    });

    it("checks the role scope's own state row for a role ref", async () => {
      stateRepo.findOne.mockResolvedValue({
        lastError: 'connect ECONNREFUSED 127.0.0.1:1234',
        lastErrorAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const warnings = await service.embeddingWarnings({
        kind: 'role',
        roleId: role.id,
      });
      expect(stateRepo.findOne).toHaveBeenCalledWith({
        where: { companyId: company.id, roleId: role.id },
      });
      expect(warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            'Last reindex failed: connect ECONNREFUSED 127.0.0.1:1234',
          ),
        ]),
      );
    });

    it("checks the shared scope's state row for a company ref", async () => {
      stateRepo.findOne.mockResolvedValue({ lastError: null });
      await service.embeddingWarnings({
        kind: 'company',
        companyId: company.id,
      });
      const [{ where }] = stateRepo.findOne.mock.calls[0] as [
        { where: { companyId: string } },
      ];
      expect(where.companyId).toBe(company.id);
    });

    it('is silent when the last rebuild succeeded (no lastError)', async () => {
      companyRepo.findOneBy.mockResolvedValue(
        makeCompany({
          id: company.id,
          embeddingConfig: { provider: 'lm-studio', model: 'embed' },
        }),
      );
      stateRepo.findOne.mockResolvedValue({ lastError: null });
      const warnings = await service.embeddingWarnings({
        kind: 'role',
        roleId: role.id,
      });
      expect(warnings).toEqual([]);
    });
  });
});
