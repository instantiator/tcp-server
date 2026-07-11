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
  let reindex: { bumpCompany: jest.Mock };
  let roleRepo: { findOneBy: jest.Mock; findBy: jest.Mock };
  let companyRepo: { findOneBy: jest.Mock };

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
    reindex = { bumpCompany: jest.fn().mockResolvedValue(undefined) };
    roleRepo = {
      findOneBy: jest.fn().mockResolvedValue(role),
      findBy: jest.fn().mockResolvedValue([role]),
    };
    companyRepo = { findOneBy: jest.fn().mockResolvedValue(company) };

    service = new KnowledgeService(
      storage as unknown as StorageService,
      reindex as unknown as KnowledgeReindexService,
      roleRepo as never,
      companyRepo as never,
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
});
