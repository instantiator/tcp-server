import { KnowledgeChunk } from '@tcp/shared';
import { randomUUID } from 'crypto';
import { DataSource, IsNull, Repository } from 'typeorm';
import { EmbeddingService } from '@tcp/shared';
import { RagIndexService } from './rag-index.service';

function makeEmbedding(): jest.Mocked<EmbeddingService> {
  return {
    embedTexts: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    embedQuery: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  } as unknown as jest.Mocked<EmbeddingService>;
}

function makeChunkRepo(): jest.Mocked<Repository<KnowledgeChunk>> {
  const saved: KnowledgeChunk[] = [];
  return {
    delete: jest.fn().mockResolvedValue({ affected: 0 }),
    create: jest.fn((dto) => ({ ...dto, id: randomUUID() }) as KnowledgeChunk),
    save: jest.fn().mockImplementation((chunk: KnowledgeChunk) => {
      saved.push(chunk);
      return Promise.resolve(chunk);
    }),
  } as unknown as jest.Mocked<Repository<KnowledgeChunk>>;
}

function makeDataSource(): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DataSource>;
}

const COMPANY_ID = randomUUID();
const ROLE_ID = randomUUID();
const CONFIG = { provider: 'lm-studio' as const, model: 'embed', apiKey: 'k' };

describe('RagIndexService', () => {
  let embedding: jest.Mocked<EmbeddingService>;
  let chunkRepo: jest.Mocked<Repository<KnowledgeChunk>>;
  let dataSource: jest.Mocked<DataSource>;
  let service: RagIndexService;

  beforeEach(() => {
    embedding = makeEmbedding();
    chunkRepo = makeChunkRepo();
    dataSource = makeDataSource();
    service = new RagIndexService(embedding, chunkRepo, dataSource);
  });

  describe('ingestDocument', () => {
    it('is a no-op when embeddingConfig is null', async () => {
      await service.ingestDocument(
        COMPANY_ID,
        ROLE_ID,
        'doc.md',
        'content',
        null,
      );
      expect(chunkRepo.delete).not.toHaveBeenCalled();
      expect(embedding.embedTexts).not.toHaveBeenCalled();
    });

    it('is a no-op for empty content', async () => {
      await service.ingestDocument(COMPANY_ID, ROLE_ID, 'doc.md', '', CONFIG);
      expect(chunkRepo.save).not.toHaveBeenCalled();
    });

    it('is a no-op for whitespace-only content', async () => {
      await service.ingestDocument(
        COMPANY_ID,
        ROLE_ID,
        'doc.md',
        '   \n\n   ',
        CONFIG,
      );
      expect(chunkRepo.save).not.toHaveBeenCalled();
    });

    it('deletes existing chunks before re-indexing', async () => {
      await service.ingestDocument(
        COMPANY_ID,
        ROLE_ID,
        'doc.md',
        'Hello world.',
        CONFIG,
      );
      expect(chunkRepo.delete).toHaveBeenCalledWith({
        roleId: ROLE_ID,
        documentPath: 'doc.md',
      });
    });

    it('saves one chunk and writes the embedding for a short document', async () => {
      const vector = [0.1, 0.2, 0.3];
      embedding.embedTexts.mockResolvedValue([vector]);
      await service.ingestDocument(
        COMPANY_ID,
        ROLE_ID,
        'doc.md',
        'Short content.',
        CONFIG,
      );
      expect(chunkRepo.save).toHaveBeenCalledTimes(1);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE "knowledge_chunk"'),
        expect.any(Array),
      );
    });

    it('splits a long document into multiple chunks', async () => {
      // Build a document with enough paragraphs to exceed the 2000-char chunk limit
      const para = 'A'.repeat(600);
      const doc = [para, para, para, para].join('\n\n');
      embedding.embedTexts.mockResolvedValue([[0.1], [0.1], [0.1]]);
      await service.ingestDocument(COMPANY_ID, ROLE_ID, 'big.md', doc, CONFIG);
      expect(chunkRepo.save.mock.calls.length).toBeGreaterThan(1);
    });

    it('assigns sequential chunkIndex values', async () => {
      const para = 'B'.repeat(600);
      const doc = [para, para, para, para].join('\n\n');
      const vectors = [[0.1], [0.2], [0.3]];
      embedding.embedTexts.mockResolvedValue(vectors);
      const savedChunks: KnowledgeChunk[] = [];
      chunkRepo.save.mockImplementation((chunk) => {
        savedChunks.push(chunk as KnowledgeChunk);
        return Promise.resolve(chunk as KnowledgeChunk);
      });
      await service.ingestDocument(COMPANY_ID, ROLE_ID, 'big.md', doc, CONFIG);
      savedChunks.forEach((c, i) => expect(c.chunkIndex).toBe(i));
    });

    it('passes all chunks to embedTexts in one call', async () => {
      const para = 'C'.repeat(600);
      const doc = [para, para, para, para].join('\n\n');
      const vectors = [[0.1], [0.2], [0.3]];
      embedding.embedTexts.mockResolvedValue(vectors);
      await service.ingestDocument(COMPANY_ID, ROLE_ID, 'big.md', doc, CONFIG);
      expect(embedding.embedTexts).toHaveBeenCalledTimes(1);
      const [, texts] = embedding.embedTexts.mock.calls[0];
      expect(texts.length).toBeGreaterThan(1);
    });
  });

  describe('removeDocument', () => {
    it('deletes chunks by roleId and documentPath', async () => {
      await service.removeDocument(ROLE_ID, 'doc.md');
      expect(chunkRepo.delete).toHaveBeenCalledWith({
        roleId: ROLE_ID,
        documentPath: 'doc.md',
      });
    });

    it('deletes shared-scope chunks (roleId IS NULL) when roleId is null', async () => {
      await service.removeDocument(null, 'doc.md');
      expect(chunkRepo.delete).toHaveBeenCalledWith({
        roleId: IsNull(),
        documentPath: 'doc.md',
      });
    });
  });

  describe('ingestDocument (shared scope)', () => {
    it('saves chunks with a null roleId for a company-shared document', async () => {
      const savedChunks: KnowledgeChunk[] = [];
      chunkRepo.save.mockImplementation((chunk) => {
        savedChunks.push(chunk as KnowledgeChunk);
        return Promise.resolve(chunk as KnowledgeChunk);
      });
      await service.ingestDocument(
        COMPANY_ID,
        null,
        'shared-doc.md',
        'Shared content.',
        CONFIG,
      );
      expect(chunkRepo.delete).toHaveBeenCalledWith({
        roleId: IsNull(),
        documentPath: 'shared-doc.md',
      });
      expect(savedChunks).toHaveLength(1);
      expect(savedChunks[0].roleId).toBeNull();
    });
  });
});

describe('splitIntoChunks (via ingestDocument)', () => {
  // We test the chunk-splitting behaviour indirectly through the service since
  // splitIntoChunks is a private module-level function.
  let service: RagIndexService;
  let chunkRepo: jest.Mocked<Repository<KnowledgeChunk>>;

  beforeEach(() => {
    const embedding = makeEmbedding();
    chunkRepo = makeChunkRepo();
    const dataSource = makeDataSource();
    embedding.embedTexts.mockImplementation((_cfg, texts) =>
      Promise.resolve(texts.map(() => [0.1])),
    );
    service = new RagIndexService(embedding, chunkRepo, dataSource);
  });

  it('joins short paragraphs into a single chunk', async () => {
    const doc = 'Para one.\n\nPara two.\n\nPara three.';
    await service.ingestDocument(COMPANY_ID, ROLE_ID, 'd.md', doc, CONFIG);
    expect(chunkRepo.save).toHaveBeenCalledTimes(1);
  });

  it('splits on sentence boundaries inside an oversized paragraph', async () => {
    // Each sentence is ~58 chars; 40 × 58 = 2320 chars — exceeds the 2000-char limit.
    // The splitter will accumulate sentences until the chunk exceeds 2000, then start a new one.
    const sentence =
      'This is a fairly long sentence that ends right here exactly. ';
    const doc = sentence.repeat(40).trim();
    expect(doc.length).toBeGreaterThan(2000); // sanity-check the test itself
    await service.ingestDocument(COMPANY_ID, ROLE_ID, 'd.md', doc, CONFIG);
    expect(chunkRepo.save.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('handles unicode content without crashing', async () => {
    const doc =
      '🎉 Unicode paragraph.\n\n日本語のテキスト。\n\nEmoji 🚀 mixed content.';
    await expect(
      service.ingestDocument(COMPANY_ID, ROLE_ID, 'd.md', doc, CONFIG),
    ).resolves.not.toThrow();
  });
});
