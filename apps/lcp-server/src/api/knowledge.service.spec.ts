import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LcpCompany, LcpRole } from '@lcp/shared';
import { KnowledgeReindexService } from '../rag/knowledge-reindex.service';
import { StorageObject, StorageService } from '../storage/storage.service';
import { KnowledgeService } from './knowledge.service';

function makeRole(overrides: Partial<LcpRole> = {}): LcpRole {
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

function makeCompany(overrides: Partial<LcpCompany> = {}): LcpCompany {
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
});
