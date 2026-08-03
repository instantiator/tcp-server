import {
  AuditEventType,
  EmbeddingService,
  KnowledgeRetrievalService,
  RagChunk,
  TcpCompany,
  TcpRole,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { DataSource, Repository } from 'typeorm';
import { AuditClientService } from '@tcp/shared';
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
): jest.Mocked<Repository<TcpCompany>> {
  return {
    findOne: jest
      .fn()
      .mockResolvedValue(embeddingConfig ? { embeddingConfig } : null),
  } as unknown as jest.Mocked<Repository<TcpCompany>>;
}

function makeKnowledge(
  chunks: RagChunk[] = [],
): jest.Mocked<KnowledgeRetrievalService> {
  return {
    retrieve: jest.fn().mockResolvedValue(chunks),
  } as unknown as jest.Mocked<KnowledgeRetrievalService>;
}

function makeRoleRepo(
  name: string | null = 'analyst',
): jest.Mocked<Repository<TcpRole>> {
  return {
    findOne: jest.fn().mockResolvedValue(name === null ? null : { name }),
  } as unknown as jest.Mocked<Repository<TcpRole>>;
}

function makeDataSource(rows: unknown[] = []): jest.Mocked<DataSource> {
  return {
    query: jest.fn().mockResolvedValue(rows),
  } as unknown as jest.Mocked<DataSource>;
}

// No EMBEDDING_* env vars set — every test relies on the company's own
// embeddingConfig (via makeCompanyRepo), matching production's precedence
// (company wins over the env fallback).
function makeConfig(): jest.Mocked<ConfigService> {
  return {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as jest.Mocked<ConfigService>;
}

function makeService({
  embedding = makeEmbedding(),
  knowledge = makeKnowledge(),
  audit = makeAudit(),
  config = makeConfig(),
  companyRepo = makeCompanyRepo(),
  roleRepo = makeRoleRepo(),
  dataSource = makeDataSource(),
} = {}) {
  return new MemoryToolsService(
    embedding,
    knowledge,
    audit,
    config,
    companyRepo,
    roleRepo,
    dataSource,
  );
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
  // The audit trail denormalises the role *name*; this service only receives a
  // roleId, and used to write that UUID straight into the name column.
  describe('audit role', () => {
    it.each(['recall', 'remember', 'search_knowledge'])(
      'records the role name rather than the roleId for %s',
      async (tool) => {
        const audit = makeAudit();
        // One row satisfies all three: the searches format it, remember's
        // INSERT ... RETURNING reads its id.
        const dataSource = makeDataSource([
          {
            id: 'mem-1',
            source: 'knowledge',
            path: 'doc.md',
            content: 'c',
            similarity: 0.9,
          },
        ]);
        await callTool(makeService({ audit, dataSource }), tool, {
          roleId: ROLE_ID,
          companyId: COMPANY_ID,
          query: 'q',
          content: 'c',
        });

        expect(audit.record).toHaveBeenCalledWith(
          COMPANY_ID,
          'analyst',
          null,
          AuditEventType.ToolCall,
          expect.objectContaining({ tool }),
        );
      },
    );

    it('falls back to "agent" when the role no longer exists', async () => {
      const audit = makeAudit();
      await callTool(
        makeService({ audit, roleRepo: makeRoleRepo(null) }),
        'recall',
        {
          roleId: ROLE_ID,
          companyId: COMPANY_ID,
          query: 'q',
        },
      );

      expect(audit.record).toHaveBeenCalledWith(
        COMPANY_ID,
        'agent',
        null,
        AuditEventType.ToolCall,
        expect.objectContaining({ tool: 'recall' }),
      );
    });
  });

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

    it('falls through to the EMBEDDING_* env fallback when the company has no embedding config', async () => {
      const envConfig = {
        get: jest.fn(
          (key: string) =>
            ({
              EMBEDDING_PROVIDER: 'lm-studio',
              EMBEDDING_MODEL: 'nomic-embed-text',
              EMBEDDING_BASE_URL: 'http://localhost:1234/v1',
            })[key],
        ),
      } as unknown as jest.Mocked<ConfigService>;
      const embedding = makeEmbedding();
      const svc = makeService({
        embedding,
        config: envConfig,
        companyRepo: makeCompanyRepo(null),
        dataSource: makeDataSource([]),
      });

      await svc.hybridSearch(COMPANY_ID, ROLE_ID, 'query', 5);

      expect(embedding.embedQuery).toHaveBeenCalledWith(
        {
          provider: 'lm-studio',
          model: 'nomic-embed-text',
          baseUrl: 'http://localhost:1234/v1',
          apiKey: undefined,
        },
        'query',
      );
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

    // Scoping, thresholding and the SQL itself belong to the shared
    // KnowledgeRetrievalService and are covered by its own spec; what matters
    // here is that memory delegates rather than running its own query.
    it('delegates to the shared retriever with the company embedding config', async () => {
      const knowledge = makeKnowledge();
      const dataSource = makeDataSource([]);
      const svc = makeService({ knowledge, dataSource });

      await svc.knowledgeSearch(COMPANY_ID, ROLE_ID, 'q', 5);

      expect(knowledge.retrieve).toHaveBeenCalledWith(
        ROLE_ID,
        COMPANY_ID,
        'q',
        EMBEDDING_CONFIG,
        5,
      );
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('formats retrieved chunks as knowledge results', async () => {
      const knowledge = makeKnowledge([
        {
          id: randomUUID(),
          documentPath: 'handbook.md',
          chunkIndex: 0,
          content: 'relevant text',
          similarity: 0.92,
        },
      ]);
      const text = await makeService({ knowledge }).knowledgeSearch(
        COMPANY_ID,
        ROLE_ID,
        'q',
        5,
      );
      expect(text).toContain('knowledge');
      expect(text).toContain('handbook.md');
      expect(text).toContain('relevant text');
      expect(text).toContain('0.92');
    });

    it('returns no_results for empty results', async () => {
      const text = await makeService().knowledgeSearch(
        COMPANY_ID,
        ROLE_ID,
        'q',
        5,
      );
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
