import { BadRequestException, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request } from 'express';
import { DocumentSummary, KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

function fakeRequest(sub: string | null = 'user-1'): Request {
  return { user: sub ? { sub } : undefined } as unknown as Request;
}

function makeSummary(
  overrides: Partial<DocumentSummary> = {},
): DocumentSummary {
  return {
    key: 'acme/knowledge/analyst/report.md',
    name: 'report.md',
    size: 10,
    lastModified: new Date('2025-01-01').toISOString(),
    ...overrides,
  };
}

describe('KnowledgeController', () => {
  let knowledge: jest.Mocked<Pick<KnowledgeService, 'store' | 'list'>>;
  let controller: KnowledgeController;
  const roleId = randomUUID();

  beforeEach(() => {
    knowledge = {
      store: jest.fn().mockResolvedValue(makeSummary()),
      list: jest.fn().mockResolvedValue([]),
    };
    controller = new KnowledgeController(
      knowledge as unknown as KnowledgeService,
    );
  });

  describe('storeRoleKnowledgeFile', () => {
    it('converts a non-.md upload and stores it with a .md extension', async () => {
      await controller.storeRoleKnowledgeFile(
        roleId,
        { originalname: 'notes.txt', buffer: Buffer.from('Just notes.') },
        {},
        fakeRequest(),
      );

      expect(knowledge.store).toHaveBeenCalledTimes(1);
      const [ref, filename, content, originators] =
        knowledge.store.mock.calls[0];
      expect(ref).toEqual({ kind: 'role', roleId });
      expect(filename).toBe('notes.md');
      expect(content.toString('utf-8')).toContain('title: notes');
      expect(content.toString('utf-8')).toContain('Just notes.');
      expect(originators).toEqual({ user: 'user-1', agent: null, task: null });
    });

    it('stores .md uploads under their original filename', async () => {
      await controller.storeRoleKnowledgeFile(
        roleId,
        {
          originalname: 'report.md',
          buffer: Buffer.from('---\ntitle: Report\n---\n\nBody.'),
        },
        {},
        fakeRequest(),
      );

      const [, filename] = knowledge.store.mock.calls[0];
      expect(filename).toBe('report.md');
    });

    it('honours an explicit filename override, bypassing the collision guard', async () => {
      knowledge.list.mockResolvedValue([makeSummary({ name: 'custom.md' })]);

      await controller.storeRoleKnowledgeFile(
        roleId,
        { originalname: 'notes.txt', buffer: Buffer.from('Notes.') },
        { filename: 'custom.md' },
        fakeRequest(),
      );

      expect(knowledge.list).not.toHaveBeenCalled();
      const [, filename] = knowledge.store.mock.calls[0];
      expect(filename).toBe('custom.md');
    });

    it('rejects a converted filename that collides with an existing document', async () => {
      knowledge.list.mockResolvedValue([makeSummary({ name: 'notes.md' })]);

      await expect(
        controller.storeRoleKnowledgeFile(
          roleId,
          { originalname: 'notes.txt', buffer: Buffer.from('Notes.') },
          {},
          fakeRequest(),
        ),
      ).rejects.toThrow(ConflictException);
      expect(knowledge.store).not.toHaveBeenCalled();
    });

    it('does not collision-check .md uploads (no rename happens)', async () => {
      knowledge.list.mockResolvedValue([makeSummary({ name: 'report.md' })]);

      await controller.storeRoleKnowledgeFile(
        roleId,
        {
          originalname: 'report.md',
          buffer: Buffer.from('---\ntitle: Report\n---\n\nBody.'),
        },
        {},
        fakeRequest(),
      );

      expect(knowledge.list).not.toHaveBeenCalled();
      expect(knowledge.store).toHaveBeenCalledTimes(1);
    });

    it('rejects an unsupported extension with a 400', async () => {
      await expect(
        controller.storeRoleKnowledgeFile(
          roleId,
          { originalname: 'archive.zip', buffer: Buffer.from('') },
          {},
          fakeRequest(),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(knowledge.store).not.toHaveBeenCalled();
    });
  });

  describe('storeCompanyKnowledgeFile', () => {
    it('converts and stores under the company scope', async () => {
      await controller.storeCompanyKnowledgeFile(
        'acme',
        { originalname: 'handbook.csv', buffer: Buffer.from('a,b\n1,2\n') },
        {},
        fakeRequest(),
      );

      const [ref, filename, content] = knowledge.store.mock.calls[0];
      expect(ref).toEqual({ kind: 'company', companyId: 'acme' });
      expect(filename).toBe('handbook.md');
      expect(content.toString('utf-8')).toContain('```csv');
    });
  });
});
