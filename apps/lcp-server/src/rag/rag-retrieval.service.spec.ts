import { randomUUID } from 'crypto';
import { LlmConfig } from '@lcp/shared';
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
    const result = await svc.retrieve(randomUUID(), 'query', null);
    expect(result).toEqual([]);
  });

  it('passes roleId and threshold to the SQL query', async () => {
    const ds = makeDataSource([]);
    const embedding = makeEmbedding();
    const svc = new RagRetrievalService(embedding, ds as never);
    const roleId = randomUUID();

    await svc.retrieve(roleId, 'query', config, 5, 0.8);

    expect(ds.query).toHaveBeenCalledWith(
      expect.stringContaining('"roleId" = $2'),
      expect.arrayContaining([roleId, 0.8, 5]),
    );
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

    const result = await svc.retrieve(randomUUID(), 'query', config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(chunk);
  });

  it('skips retrieval and returns empty array when embeddingConfig is undefined', async () => {
    const ds = makeDataSource([]);
    const svc = new RagRetrievalService(makeEmbedding(), ds as never);
    const result = await svc.retrieve(randomUUID(), 'query', undefined);
    expect(result).toEqual([]);
    expect(ds.query).not.toHaveBeenCalled();
  });
});
