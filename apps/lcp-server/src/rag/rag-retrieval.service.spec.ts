import { randomUUID } from 'crypto';
import { DEFAULT_RAG_THRESHOLD, LlmConfig } from '@lcp/shared';
import { EmbeddingService } from './embedding.service';
import { RagRetrievalService } from './rag-retrieval.service';

const config: LlmConfig = {
  provider: 'lm-studio',
  model: 'nomic-embed-text',
};

const QUERY_VECTOR = [0.1, 0.2, 0.3];

function makeDataSource(rows: unknown[]) {
  return { query: jest.fn().mockResolvedValue(rows) };
}

function makeEmbedding(vec = QUERY_VECTOR): EmbeddingService {
  return {
    embedQuery: jest.fn().mockResolvedValue(vec),
  } as unknown as EmbeddingService;
}

describe('RagRetrievalService', () => {
  it('returns empty array when embeddingConfig is null', async () => {
    const svc = new RagRetrievalService(
      makeEmbedding(),
      makeDataSource([]) as never,
    );
    const result = await svc.retrieve(
      randomUUID(),
      randomUUID(),
      'query',
      null,
    );
    expect(result).toEqual([]);
  });

  it('scopes the query to the role plus the company shared chunks', async () => {
    const ds = makeDataSource([]);
    const embedding = makeEmbedding();
    const svc = new RagRetrievalService(embedding, ds as never);
    const roleId = randomUUID();
    const companyId = randomUUID();

    await svc.retrieve(roleId, companyId, 'query', config, 5, 0.8);

    expect(ds.query).toHaveBeenCalledWith(
      expect.stringContaining(
        '(("roleId" = $2) OR ("roleId" IS NULL AND "companyId" = $3))',
      ),
      expect.arrayContaining([roleId, companyId, 0.8, 5]),
    );
  });

  it('applies DEFAULT_RAG_THRESHOLD when the caller passes no threshold', async () => {
    const ds = makeDataSource([]);
    const svc = new RagRetrievalService(makeEmbedding(), ds as never);

    await svc.retrieve(randomUUID(), randomUUID(), 'query', config);

    // Guards the failure mode this default was calibrated against: a
    // threshold above the embedding model's real score range filters out
    // every chunk, so retrieval silently returns nothing at all.
    expect(ds.query).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([DEFAULT_RAG_THRESHOLD]),
    );
    expect(DEFAULT_RAG_THRESHOLD).toBeLessThan(0.7);
  });

  it('returns mapped rows from the database', async () => {
    const chunk = {
      id: randomUUID(),
      documentPath: 'knowledge/analyst/report.md',
      chunkIndex: 2,
      content: 'Important paragraph.',
      similarity: 0.91,
    };
    const ds = makeDataSource([chunk]);
    const svc = new RagRetrievalService(makeEmbedding(), ds as never);

    const result = await svc.retrieve(
      randomUUID(),
      randomUUID(),
      'query',
      config,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(chunk);
  });

  it('skips retrieval and returns empty array when embeddingConfig is undefined', async () => {
    const ds = makeDataSource([]);
    const svc = new RagRetrievalService(makeEmbedding(), ds as never);
    const result = await svc.retrieve(
      randomUUID(),
      randomUUID(),
      'query',
      undefined,
    );
    expect(result).toEqual([]);
    expect(ds.query).not.toHaveBeenCalled();
  });
});
