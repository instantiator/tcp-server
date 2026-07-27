import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import { DocumentSummary, KnowledgeService } from './knowledge.service';
import { KnowledgeController } from './knowledge.controller';

function fakeRequest(sub: string | null = 'user-1'): Request {
  return { user: sub ? { sub } : undefined } as unknown as Request;
}

/** Minimal fake of the passthrough `Response` object the controller sets headers on. */
function fakeRes(): jest.Mocked<Pick<Response, 'setHeader'>> {
  return { setHeader: jest.fn() };
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
  let knowledge: jest.Mocked<
    Pick<KnowledgeService, 'store' | 'list' | 'queryRag' | 'embeddingWarnings'>
  >;
  let controller: KnowledgeController;
  const roleId = randomUUID();

  beforeEach(() => {
    knowledge = {
      store: jest.fn().mockResolvedValue(makeSummary()),
      list: jest.fn().mockResolvedValue([]),
      queryRag: jest.fn().mockResolvedValue([]),
      embeddingWarnings: jest.fn().mockResolvedValue([]),
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
        fakeRes() as unknown as Response,
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
        fakeRes() as unknown as Response,
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
        fakeRes() as unknown as Response,
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
          fakeRes() as unknown as Response,
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
        fakeRes() as unknown as Response,
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
          fakeRes() as unknown as Response,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(knowledge.store).not.toHaveBeenCalled();
    });

    it('sets X-Tcp-Warnings from KnowledgeService.embeddingWarnings after a successful store', async () => {
      knowledge.embeddingWarnings.mockResolvedValue(['No embedding config.']);
      const res = fakeRes();

      await controller.storeRoleKnowledgeFile(
        roleId,
        {
          originalname: 'report.md',
          buffer: Buffer.from('---\ntitle: R\n---\n\nB.'),
        },
        {},
        fakeRequest(),
        res as unknown as Response,
      );

      expect(knowledge.embeddingWarnings).toHaveBeenCalledWith({
        kind: 'role',
        roleId,
      });
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Tcp-Warnings',
        JSON.stringify([encodeURIComponent('No embedding config.')]),
      );
    });
  });

  describe('queryRoleKnowledge', () => {
    it('delegates to knowledge.queryRag with parsed topK/threshold', async () => {
      const chunks = [
        {
          id: randomUUID(),
          documentPath: 'acme/knowledge/analyst/report.md',
          chunkIndex: 0,
          content: 'Some chunk text.',
          similarity: 0.92,
        },
      ];
      knowledge.queryRag.mockResolvedValue(chunks);

      const result = await controller.queryRoleKnowledge(
        roleId,
        fakeRes() as unknown as Response,
        'remote work policy',
        '3',
        '0.5',
      );

      expect(result).toBe(chunks);
      expect(knowledge.queryRag).toHaveBeenCalledWith(
        roleId,
        'remote work policy',
        3,
        0.5,
      );
    });

    it('omits topK/threshold when not given, leaving service defaults in effect', async () => {
      await controller.queryRoleKnowledge(
        roleId,
        fakeRes() as unknown as Response,
        'remote work policy',
      );
      expect(knowledge.queryRag).toHaveBeenCalledWith(
        roleId,
        'remote work policy',
        undefined,
        undefined,
      );
    });

    it('rejects a missing q with a 400', async () => {
      await expect(
        controller.queryRoleKnowledge(
          roleId,
          fakeRes() as unknown as Response,
          undefined,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(knowledge.queryRag).not.toHaveBeenCalled();
    });

    it('rejects an empty q with a 400', async () => {
      await expect(
        controller.queryRoleKnowledge(
          roleId,
          fakeRes() as unknown as Response,
          '',
        ),
      ).rejects.toThrow(BadRequestException);
      expect(knowledge.queryRag).not.toHaveBeenCalled();
    });

    it('propagates a 404 for an unknown role', async () => {
      knowledge.queryRag.mockRejectedValue(
        new NotFoundException(`Role ${roleId} not found`),
      );
      await expect(
        controller.queryRoleKnowledge(
          roleId,
          fakeRes() as unknown as Response,
          'query',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns an empty array (not an error) when the company has no embeddingConfig', async () => {
      knowledge.queryRag.mockResolvedValue([]);
      const result = await controller.queryRoleKnowledge(
        roleId,
        fakeRes() as unknown as Response,
        'query',
      );
      expect(result).toEqual([]);
    });

    it('sets X-Tcp-Warnings from KnowledgeService.embeddingWarnings', async () => {
      knowledge.embeddingWarnings.mockResolvedValue(['No embedding config.']);
      const res = fakeRes();

      await controller.queryRoleKnowledge(
        roleId,
        res as unknown as Response,
        'query',
      );

      expect(knowledge.embeddingWarnings).toHaveBeenCalledWith({
        kind: 'role',
        roleId,
      });
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Tcp-Warnings',
        JSON.stringify([encodeURIComponent('No embedding config.')]),
      );
    });
  });

  describe('storeCompanyKnowledgeFile', () => {
    it('converts and stores under the company scope', async () => {
      await controller.storeCompanyKnowledgeFile(
        'acme',
        { originalname: 'handbook.csv', buffer: Buffer.from('a,b\n1,2\n') },
        {},
        fakeRequest(),
        fakeRes() as unknown as Response,
      );

      const [ref, filename, content] = knowledge.store.mock.calls[0];
      expect(ref).toEqual({ kind: 'company', companyId: 'acme' });
      expect(filename).toBe('handbook.md');
      expect(content.toString('utf-8')).toContain('```csv');
    });
  });
});
