import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { LcpCompany, LcpRole } from '@lcp/shared';
import { RagIndexService } from '../rag/rag-index.service';
import { MinioService, StorageObject } from '../storage/minio.service';
import { RoleDocumentService } from './role-document.service';

function makeRole(overrides: Partial<LcpRole> = {}): LcpRole {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
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
    ...overrides,
  };
}

function makeStorageObject(name: string): StorageObject {
  return {
    key: `acme/knowledge/analyst/${name}`,
    name,
    size: 100,
    lastModified: new Date('2025-01-01'),
  };
}

describe('RoleDocumentService', () => {
  let service: RoleDocumentService;
  let minio: {
    listKnowledgeFiles: jest.Mock;
    putKnowledgeFile: jest.Mock;
    deleteKnowledgeFile: jest.Mock;
  };
  let ragIndex: { ingestDocument: jest.Mock; removeDocument: jest.Mock };
  let roleRepo: { findOneBy: jest.Mock };
  let companyRepo: { findOneBy: jest.Mock };

  const role = makeRole();
  const company = makeCompany({ id: role.companyId });

  beforeEach(() => {
    minio = {
      listKnowledgeFiles: jest.fn().mockResolvedValue([]),
      putKnowledgeFile: jest
        .fn()
        .mockResolvedValue('acme/knowledge/analyst/report.md'),
      deleteKnowledgeFile: jest.fn().mockResolvedValue(undefined),
    };
    ragIndex = {
      ingestDocument: jest.fn().mockResolvedValue(undefined),
      removeDocument: jest.fn().mockResolvedValue(undefined),
    };
    roleRepo = { findOneBy: jest.fn().mockResolvedValue(role) };
    companyRepo = { findOneBy: jest.fn().mockResolvedValue(company) };

    service = new RoleDocumentService(
      minio as unknown as MinioService,
      ragIndex as unknown as RagIndexService,
      roleRepo as never,
      companyRepo as never,
    );
  });

  describe('listDocuments', () => {
    it('returns mapped summaries from MinIO', async () => {
      minio.listKnowledgeFiles.mockResolvedValue([
        makeStorageObject('report.md'),
        makeStorageObject('handbook.md'),
      ]);
      const result = await service.listDocuments(role.id);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('report.md');
      expect(result[1].name).toBe('handbook.md');
    });

    it('throws NotFoundException when role does not exist', async () => {
      roleRepo.findOneBy.mockResolvedValue(null);
      await expect(service.listDocuments(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when company does not exist', async () => {
      companyRepo.findOneBy.mockResolvedValue(null);
      await expect(service.listDocuments(role.id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('storeDocument', () => {
    it('stores in MinIO and triggers RAG indexing', async () => {
      const content = Buffer.from('# Hello\ncontent');
      await service.storeDocument(role.id, 'report.md', content);
      expect(minio.putKnowledgeFile).toHaveBeenCalledWith(
        company.slug,
        role.name,
        'report.md',
        content,
      );
      expect(ragIndex.ingestDocument).toHaveBeenCalledWith(
        company.id,
        role.id,
        'acme/knowledge/analyst/report.md',
        '# Hello\ncontent',
        company.embeddingConfig,
      );
    });

    it('returns summary with correct fields', async () => {
      const content = Buffer.from('# Title\ncontent');
      const summary = await service.storeDocument(
        role.id,
        'report.md',
        content,
      );
      expect(summary.name).toBe('report.md');
      expect(summary.size).toBe(content.byteLength);
      expect(summary.key).toBe('acme/knowledge/analyst/report.md');
    });
  });

  describe('deleteDocuments', () => {
    it('deletes each key from MinIO and removes RAG chunks', async () => {
      const keys = [
        'acme/knowledge/analyst/report.md',
        'acme/knowledge/analyst/handbook.md',
      ];
      await service.deleteDocuments(role.id, keys);
      expect(minio.deleteKnowledgeFile).toHaveBeenCalledTimes(2);
      expect(ragIndex.removeDocument).toHaveBeenCalledTimes(2);
    });

    it('is a no-op when keys array is empty', async () => {
      await service.deleteDocuments(role.id, []);
      expect(minio.deleteKnowledgeFile).not.toHaveBeenCalled();
      expect(ragIndex.removeDocument).not.toHaveBeenCalled();
    });
  });
});
