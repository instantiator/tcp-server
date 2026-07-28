import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { DEFAULT_RAG_THRESHOLD } from '../config/defaults';
import type { LlmConfig } from '../models/LlmConfig.model';
import { EmbeddingService } from './embedding.service';
import { KnowledgeRetrievalService } from './knowledge-retrieval.service';

const ROLE_ID = randomUUID();
const COMPANY_ID = randomUUID();
const EMBEDDING_CONFIG: LlmConfig = {
  provider: 'lm-studio',
  model: 'nomic-embed-text',
};

function makeEmbedding(vec = [0.1, 0.2, 0.3]): jest.Mocked<EmbeddingService> {
  return {
    embedQuery: jest.fn().mockResolvedValue(vec),
    embedTexts: jest.fn().mockResolvedValue([vec]),
  } as unknown as jest.Mocked<EmbeddingService>;
}

function makeDataSource(rows: unknown[] = []): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as jest.Mocked<DataSource>;
}

function makeService(rows: unknown[] = [], embedding = makeEmbedding()) {
  const dataSource = makeDataSource(rows);
  return {
    svc: new KnowledgeRetrievalService(embedding, dataSource),
    dataSource,
    embedding,
  };
}

describe('KnowledgeRetrievalService', () => {
  describe('without an embedding config', () => {
    // No embedding config means the company cannot embed the query at all —
    // retrieval is skipped entirely rather than run against a null vector.
    it.each([
      ['null', null],
      ['undefined', undefined],
    ])('returns [] and never queries when config is %s', async (_, config) => {
      const { svc, dataSource, embedding } = makeService();
      await expect(
        svc.retrieve(ROLE_ID, COMPANY_ID, 'query', config),
      ).resolves.toEqual([]);
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(embedding.embedQuery).not.toHaveBeenCalled();
    });
  });

  it('embeds the query and searches knowledge_chunk', async () => {
    const { svc, dataSource, embedding } = makeService();
    await svc.retrieve(ROLE_ID, COMPANY_ID, 'what is the plan?', {
      ...EMBEDDING_CONFIG,
    });
    expect(embedding.embedQuery).toHaveBeenCalledWith(
      { ...EMBEDDING_CONFIG },
      'what is the plan?',
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('knowledge_chunk'),
      expect.any(Array),
    );
  });

  it('searches the role scope and the company shared scope together', async () => {
    const { svc, dataSource } = makeService();
    await svc.retrieve(ROLE_ID, COMPANY_ID, 'q', EMBEDDING_CONFIG, 3, 0.8);

    const [sql, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      '(("roleId" = $2) OR ("roleId" IS NULL AND "companyId" = $3))',
    );
    expect(params).toEqual(
      expect.arrayContaining([ROLE_ID, COMPANY_ID, 0.8, 3]),
    );
  });

  it('honours topK and threshold, defaulting to 5 and DEFAULT_RAG_THRESHOLD', async () => {
    const { svc, dataSource } = makeService();
    await svc.retrieve(ROLE_ID, COMPANY_ID, 'q', EMBEDDING_CONFIG);

    const [, params] = dataSource.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(expect.arrayContaining([DEFAULT_RAG_THRESHOLD, 5]));
    // Guards the failure mode this default was calibrated against: a threshold
    // above the embedding model's real score range filters out every chunk, so
    // retrieval silently returns nothing at all.
    expect(DEFAULT_RAG_THRESHOLD).toBeLessThan(0.7);
  });

  it('returns the rows the database ranked, unchanged', async () => {
    const chunk = {
      id: randomUUID(),
      documentPath: 'knowledge/analyst/report.md',
      chunkIndex: 2,
      content: 'Important paragraph.',
      similarity: 0.91,
    };
    const { svc } = makeService([chunk]);
    await expect(
      svc.retrieve(ROLE_ID, COMPANY_ID, 'q', EMBEDDING_CONFIG),
    ).resolves.toEqual([chunk]);
  });

  it('returns [] when nothing clears the threshold', async () => {
    const { svc } = makeService([]);
    await expect(
      svc.retrieve(ROLE_ID, COMPANY_ID, 'q', EMBEDDING_CONFIG),
    ).resolves.toEqual([]);
  });
});
