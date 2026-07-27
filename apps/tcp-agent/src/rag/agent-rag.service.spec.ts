import { EmbeddingService } from '@tcp/shared';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AgentRagService } from './agent-rag.service';

const ROLE_ID = randomUUID();
const COMPANY_ID = randomUUID();
const EMBEDDING_CONFIG = {
  provider: 'lm-studio' as const,
  model: 'embed',
  apiKey: 'k',
};

function makeEmbedding(): jest.Mocked<EmbeddingService> {
  return {
    embedQuery: jest.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    embedTexts: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
  } as unknown as jest.Mocked<EmbeddingService>;
}

function makeDataSource(rows: unknown[] = []): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as jest.Mocked<DataSource>;
}

describe('AgentRagService', () => {
  describe('retrieve', () => {
    it('returns empty array when embeddingConfig is null', async () => {
      const svc = new AgentRagService(makeEmbedding(), makeDataSource());
      const result = await svc.retrieve(ROLE_ID, COMPANY_ID, 'query', null);
      expect(result).toEqual([]);
    });

    it('returns empty array when embeddingConfig is undefined', async () => {
      const svc = new AgentRagService(makeEmbedding(), makeDataSource());
      const result = await svc.retrieve(
        ROLE_ID,
        COMPANY_ID,
        'query',
        undefined,
      );
      expect(result).toEqual([]);
    });

    it('does not call the DB when config is missing', async () => {
      const ds = makeDataSource();
      const svc = new AgentRagService(makeEmbedding(), ds);
      await svc.retrieve(ROLE_ID, COMPANY_ID, 'query', null);
      expect(ds.query).not.toHaveBeenCalled();
    });

    it('embeds the query and runs a SQL search', async () => {
      const embedding = makeEmbedding();
      const ds = makeDataSource([]);
      const svc = new AgentRagService(embedding, ds);
      await svc.retrieve(
        ROLE_ID,
        COMPANY_ID,
        'what is the plan?',
        EMBEDDING_CONFIG,
      );
      expect(embedding.embedQuery).toHaveBeenCalledWith(
        EMBEDDING_CONFIG,
        'what is the plan?',
      );
      expect(ds.query).toHaveBeenCalledWith(
        expect.stringContaining('knowledge_chunk'),
        expect.any(Array),
      );
    });

    it('scopes the query to the role plus the company shared chunks', async () => {
      const ds = makeDataSource([]);
      const svc = new AgentRagService(makeEmbedding(), ds);
      await svc.retrieve(ROLE_ID, COMPANY_ID, 'q', EMBEDDING_CONFIG, 3, 0.8);
      const [sql, params] = ds.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain(
        '(("roleId" = $2) OR ("roleId" IS NULL AND "companyId" = $3))',
      );
      expect(params).toContain(ROLE_ID);
      expect(params).toContain(COMPANY_ID);
      expect(params).toContain(0.8);
      expect(params).toContain(3);
    });

    it('returns rows from the DB as-is', async () => {
      const rows = [
        {
          id: randomUUID(),
          documentPath: 'doc.md',
          chunkIndex: 0,
          content: 'text',
          similarity: 0.9,
        },
      ];
      const svc = new AgentRagService(makeEmbedding(), makeDataSource(rows));
      const result = await svc.retrieve(
        ROLE_ID,
        COMPANY_ID,
        'q',
        EMBEDDING_CONFIG,
      );
      expect(result).toEqual(rows);
    });

    it('returns empty array when no rows exceed the threshold', async () => {
      const svc = new AgentRagService(makeEmbedding(), makeDataSource([]));
      const result = await svc.retrieve(
        ROLE_ID,
        COMPANY_ID,
        'q',
        EMBEDDING_CONFIG,
      );
      expect(result).toEqual([]);
    });

    it('uses default topK=5 and threshold=0.7', async () => {
      const ds = makeDataSource([]);
      const svc = new AgentRagService(makeEmbedding(), ds);
      await svc.retrieve(ROLE_ID, COMPANY_ID, 'q', EMBEDDING_CONFIG);
      const [, params] = ds.query.mock.calls[0] as [string, unknown[]];
      expect(params).toContain(0.7);
      expect(params).toContain(5);
    });
  });

  describe('hasKnowledge', () => {
    it('is true when the existence query returns exists=true (no embedding call)', async () => {
      const embedding = makeEmbedding();
      const svc = new AgentRagService(
        embedding,
        makeDataSource([{ exists: true }]),
      );
      await expect(svc.hasKnowledge(ROLE_ID, COMPANY_ID)).resolves.toBe(true);
      expect(embedding.embedQuery).not.toHaveBeenCalled();
    });

    it('is false when the role and its shared scope have no chunks', async () => {
      const svc = new AgentRagService(
        makeEmbedding(),
        makeDataSource([{ exists: false }]),
      );
      await expect(svc.hasKnowledge(ROLE_ID, COMPANY_ID)).resolves.toBe(false);
    });
  });
});
