import { EmbeddingService, LcpCompany } from '@lcp/shared';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { AuditClientService } from '@lcp/shared';
import { memoryPrompts } from '../memory-prompts';
import { MemoryToolsService } from './memory-tools.service';

const COMPANY_ID = randomUUID();
const ROLE_ID = randomUUID();
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

function makeAudit(): jest.Mocked<AuditClientService> {
  return { record: jest.fn() } as unknown as jest.Mocked<AuditClientService>;
}

function makeCompanyRepo(
  embeddingConfig: object | null = EMBEDDING_CONFIG,
): jest.Mocked<Repository<LcpCompany>> {
  return {
    findOne: jest
      .fn()
      .mockResolvedValue(embeddingConfig ? { embeddingConfig } : null),
  } as unknown as jest.Mocked<Repository<LcpCompany>>;
}

function makeDataSource(rows: unknown[] = []): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as jest.Mocked<DataSource>;
}

function makeService({
  embedding = makeEmbedding(),
  audit = makeAudit(),
  companyRepo = makeCompanyRepo(),
  dataSource = makeDataSource(),
} = {}) {
  return new MemoryToolsService(embedding, audit, companyRepo, dataSource);
}

async function callTool(
  service: MemoryToolsService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = service.createServer();
  const tools = (server as unknown as { _registeredTools: unknown })
    ._registeredTools as Record<
    string,
    {
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[] }>;
    }
  >;
  const result = await tools[toolName].handler(args);
  return result.content[0].text;
}

describe('MemoryToolsService', () => {
  describe('describe_server', () => {
    it('returns the overview text from prompts', async () => {
      const text = await callTool(makeService(), 'describe_server', {});
      expect(text).toBe(memoryPrompts.describe_server);
    });
  });

  describe('hybridSearch', () => {
    it('returns no_embedding_config message when company has no embedding config', async () => {
      const svc = makeService({ companyRepo: makeCompanyRepo(null) });
      const text = await svc.hybridSearch(COMPANY_ID, ROLE_ID, 'query', 5);
      expect(text).toBe(memoryPrompts.no_embedding_config);
    });

    it('embeds the query and runs a UNION SQL search', async () => {
      const embedding = makeEmbedding();
      const dataSource = makeDataSource([]);
      const svc = makeService({ embedding, dataSource });
      await svc.hybridSearch(COMPANY_ID, ROLE_ID, 'what happened?', 5);
      expect(embedding.embedQuery).toHaveBeenCalledWith(
        EMBEDDING_CONFIG,
        'what happened?',
      );
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('UNION ALL'),
        expect.any(Array),
      );
    });

    it('returns formatted results when rows are found', async () => {
      const rows = [
        {
          id: randomUUID(),
          source: 'knowledge',
          path: 'doc.md',
          content: 'relevant text',
          similarity: 0.92,
        },
      ];
      const svc = makeService({ dataSource: makeDataSource(rows) });
      const text = await svc.hybridSearch(COMPANY_ID, ROLE_ID, 'q', 5);
      expect(text).toContain('knowledge');
      expect(text).toContain('relevant text');
      expect(text).toContain('0.92');
    });

    it('returns no_results message when query matches nothing', async () => {
      const svc = makeService({ dataSource: makeDataSource([]) });
      const text = await svc.hybridSearch(COMPANY_ID, ROLE_ID, 'obscure', 5);
      expect(text).toBe(memoryPrompts.no_results);
    });
  });

  describe('knowledgeSearch', () => {
    it('returns no_embedding_config when company has no config', async () => {
      const svc = makeService({ companyRepo: makeCompanyRepo(null) });
      const text = await svc.knowledgeSearch(COMPANY_ID, ROLE_ID, 'q', 5);
      expect(text).toBe(memoryPrompts.no_embedding_config);
    });

    it('queries only knowledge_chunk (not episodic_memory)', async () => {
      const dataSource = makeDataSource([]);
      const svc = makeService({ dataSource });
      await svc.knowledgeSearch(COMPANY_ID, ROLE_ID, 'q', 5);
      const sql = dataSource.query.mock.calls[0][0];
      expect(sql).toContain('knowledge_chunk');
      expect(sql).not.toContain('episodic_memory');
    });

    it('scopes to the role plus the company shared chunks', async () => {
      const dataSource = makeDataSource([]);
      const svc = makeService({ dataSource });
      await svc.knowledgeSearch(COMPANY_ID, ROLE_ID, 'q', 5);
      const [sql, params] = dataSource.query.mock.calls[0] as [
        string,
        unknown[],
      ];
      expect(sql).toContain(
        '(("roleId" = $2::uuid) OR ("roleId" IS NULL AND "companyId" = $3::uuid))',
      );
      expect(params).toContain(ROLE_ID);
      expect(params).toContain(COMPANY_ID);
    });

    it('returns no_results for empty results', async () => {
      const svc = makeService({ dataSource: makeDataSource([]) });
      const text = await svc.knowledgeSearch(COMPANY_ID, ROLE_ID, 'q', 5);
      expect(text).toBe(memoryPrompts.no_results);
    });
  });

  describe('storeMemory', () => {
    it('returns no_embedding_config_store when company has no config', async () => {
      const svc = makeService({ companyRepo: makeCompanyRepo(null) });
      const text = await svc.storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'content',
        null,
        null,
      );
      expect(text).toBe(memoryPrompts.no_embedding_config_store);
    });

    it('inserts a row and returns the memory_stored message with the ID', async () => {
      const newId = randomUUID();
      const dataSource = makeDataSource([{ id: newId }]);
      const svc = makeService({ dataSource });
      const text = await svc.storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'important insight',
        null,
        null,
      );
      expect(text).toContain(newId);
      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO episodic_memory'),
        expect.any(Array),
      );
    });

    it('stores tags as JSONB when provided', async () => {
      const newId = randomUUID();
      const dataSource = makeDataSource([{ id: newId }]);
      const svc = makeService({ dataSource });
      await svc.storeMemory(COMPANY_ID, ROLE_ID, 'tagged content', null, [
        'tag1',
        'tag2',
      ]);
      const params = dataSource.query.mock.calls[0][1] as unknown[];
      const tagsParam = params.find(
        (p) => typeof p === 'string' && p.includes('tag1'),
      );
      expect(tagsParam).toBeDefined();
    });

    it('passes agentId to the INSERT when provided', async () => {
      const agentId = randomUUID();
      const dataSource = makeDataSource([{ id: randomUUID() }]);
      const svc = makeService({ dataSource });
      await svc.storeMemory(COMPANY_ID, ROLE_ID, 'content', agentId, null);
      const params = dataSource.query.mock.calls[0][1] as unknown[];
      expect(params).toContain(agentId);
    });
  });

  describe('recall tool (via MCP server)', () => {
    it('delegates to hybridSearch and returns its result', async () => {
      const rows = [
        {
          id: randomUUID(),
          source: 'episodic',
          path: '',
          content: 'I remember this',
          similarity: 0.88,
        },
      ];
      const svc = makeService({ dataSource: makeDataSource(rows) });
      const text = await callTool(svc, 'recall', {
        roleId: ROLE_ID,
        companyId: COMPANY_ID,
        query: 'memory?',
      });
      expect(text).toContain('I remember this');
    });
  });

  describe('search_knowledge tool (via MCP server)', () => {
    it('returns no_results when knowledge base is empty', async () => {
      const svc = makeService({ dataSource: makeDataSource([]) });
      const text = await callTool(svc, 'search_knowledge', {
        roleId: ROLE_ID,
        companyId: COMPANY_ID,
        query: 'anything',
      });
      expect(text).toBe(memoryPrompts.no_results);
    });
  });

  describe('remember tool (via MCP server)', () => {
    it('stores memory and returns interpolated confirmation', async () => {
      const newId = randomUUID();
      const svc = makeService({ dataSource: makeDataSource([{ id: newId }]) });
      const text = await callTool(svc, 'remember', {
        roleId: ROLE_ID,
        companyId: COMPANY_ID,
        content: 'Something important happened',
      });
      expect(text).toContain(newId);
    });
  });
});
