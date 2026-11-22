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

    it('searches episodic memories within the company only', async () => {
      const dataSource = makeDataSource([]);
      await makeService({ dataSource }).hybridSearch(
        COMPANY_ID,
        ROLE_ID,
        'q',
        5,
      );
      const sql = String(dataSource.query.mock.calls[0][0]);
      const episodic = sql.slice(sql.indexOf('FROM episodic_memory'));
      expect(episodic).toContain('"companyId" = $3::uuid');
    });

    it('labels an episodic result with its memory id, for `replaces`', async () => {
      const id = randomUUID();
      const svc = makeService({
        dataSource: makeDataSource([
          { id, source: 'episodic', path: '', content: 'm', similarity: 0.8 },
        ]),
      });
      const text = await svc.hybridSearch(COMPANY_ID, ROLE_ID, 'q', 5);
      expect(text).toContain(`memory: ${id}`);
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
    /** Answers the nearest-memory lookup, the INSERT and the UPDATE separately. */
    function routedDataSource({
      nearest = [] as unknown[],
      inserted = [{ id: randomUUID() }] as unknown[],
      updated = [[{ id: randomUUID() }], 1] as unknown[],
    } = {}): jest.Mocked<DataSource> {
      return {
        query: jest.fn((sql: string) =>
          Promise.resolve(
            sql.includes('INSERT')
              ? inserted
              : sql.includes('UPDATE')
                ? updated
                : nearest,
          ),
        ),
      } as unknown as jest.Mocked<DataSource>;
    }

    const insertParams = (ds: jest.Mocked<DataSource>): unknown[] =>
      ds.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT'),
      )![1] as unknown[];

    it('stores nothing and says so when the company has no embedding config', async () => {
      const dataSource = routedDataSource();
      const svc = makeService({
        companyRepo: makeCompanyRepo(null),
        dataSource,
      });
      const outcome = await svc.storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'content',
        null,
        null,
      );
      expect(outcome).toEqual({
        text: memoryPrompts.no_embedding_config_store,
      });
      expect(memoryPrompts.no_embedding_config_store).toContain('NOT stored');
      expect(dataSource.query).not.toHaveBeenCalled();
    });

    it('inserts a row and reports it as created', async () => {
      const newId = randomUUID();
      const dataSource = routedDataSource({ inserted: [{ id: newId }] });
      const outcome = await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'important insight',
        null,
        null,
      );
      expect(outcome.text).toContain(newId);
      expect(outcome.write).toEqual({ action: 'created', memoryId: newId });
    });

    it('stores tags as JSONB and passes agentId when provided', async () => {
      const agentId = randomUUID();
      const dataSource = routedDataSource();
      await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'tagged content',
        agentId,
        ['tag1', 'tag2'],
      );
      const params = insertParams(dataSource);
      expect(params).toContain(agentId);
      expect(params).toContain(JSON.stringify(['tag1', 'tag2']));
    });

    it('looks for duplicates only within the same role and company', async () => {
      const dataSource = routedDataSource();
      await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'c',
        null,
        null,
      );
      const [sql, params] = dataSource.query.mock.calls[0];
      expect(sql).toContain('"roleId" = $2');
      expect(sql).toContain('"companyId" = $3');
      expect(params).toEqual([expect.any(String), ROLE_ID, COMPANY_ID]);
    });

    it('refuses a near-duplicate, quoting the existing memory', async () => {
      const existing = randomUUID();
      const dataSource = routedDataSource({
        nearest: [{ id: existing, content: 'Tea is £3', similarity: 0.95 }],
      });
      const outcome = await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'Tea costs £3',
        null,
        null,
      );
      expect(outcome.write).toBeUndefined();
      expect(outcome.text).toContain(existing);
      expect(outcome.text).toContain('Tea is £3');
      expect(outcome.text).toContain('`replaces`');
      expect(
        dataSource.query.mock.calls.some(([sql]) =>
          String(sql).includes('INSERT'),
        ),
      ).toBe(false);
    });

    it('stores a memory just below the duplicate threshold', async () => {
      const dataSource = routedDataSource({
        nearest: [{ id: randomUUID(), content: 'x', similarity: 0.91 }],
      });
      const outcome = await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'y',
        null,
        null,
      );
      expect(outcome.write?.action).toBe('created');
    });

    it('corrects a memory in place with `replaces`, bumping its version', async () => {
      const target = randomUUID();
      const dataSource = routedDataSource({ updated: [[{ id: target }], 1] });
      const outcome = await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'Tea is £4 now',
        null,
        null,
        target,
      );
      expect(outcome.write).toEqual({ action: 'updated', memoryId: target });
      const [sql, params] = dataSource.query.mock.calls[0];
      expect(sql).toContain('version = version + 1');
      expect(sql).toContain('"roleId" = $2');
      expect(sql).toContain('"companyId" = $3');
      expect(params).toEqual(
        expect.arrayContaining([target, ROLE_ID, COMPANY_ID]),
      );
    });

    it("refuses `replaces` naming a memory that isn't this role's", async () => {
      const dataSource = routedDataSource({ updated: [[], 0] });
      const other = randomUUID();
      const outcome = await makeService({ dataSource }).storeMemory(
        COMPANY_ID,
        ROLE_ID,
        'x',
        null,
        null,
        other,
      );
      expect(outcome.write).toBeUndefined();
      expect(outcome.text).toBe(
        memoryPrompts.memory_replace_not_found.replace('{{id}}', other),
      );
    });
  });

  describe('remember tool (via MCP server)', () => {
    it('caps content length and tag count in its schema', () => {
      const server = makeService().createServer();
      const { inputSchema } = (
        server as unknown as {
          _registeredTools: Record<
            string,
            { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }
          >;
        }
      )._registeredTools.remember;
      const base = { roleId: ROLE_ID, companyId: COMPANY_ID };
      expect(
        inputSchema.safeParse({ ...base, content: 'x'.repeat(2000) }).success,
      ).toBe(true);
      expect(
        inputSchema.safeParse({ ...base, content: 'x'.repeat(2001) }).success,
      ).toBe(false);
      expect(inputSchema.safeParse({ ...base, content: '  ' }).success).toBe(
        false,
      );
      expect(
        inputSchema.safeParse({
          ...base,
          content: 'x',
          tags: Array.from({ length: 11 }, (_, i) => `t${i}`),
        }).success,
      ).toBe(false);
    });

    it('audits a content-free memory state change after a write', async () => {
      const audit = makeAudit();
      const newId = randomUUID();
      const dataSource = {
        query: jest.fn((sql: string) =>
          Promise.resolve(sql.includes('INSERT') ? [{ id: newId }] : []),
        ),
      } as unknown as jest.Mocked<DataSource>;
      await callTool(makeService({ audit, dataSource }), 'remember', {
        roleId: ROLE_ID,
        companyId: COMPANY_ID,
        content: 'secret fact',
      });
      expect(audit.record).toHaveBeenCalledWith(
        COMPANY_ID,
        'analyst',
        null,
        AuditEventType.StateChange,
        {
          source: 'memory',
          roleId: ROLE_ID,
          action: 'created',
          memoryId: newId,
        },
      );
    });

    it('audits no state change when nothing was stored', async () => {
      const audit = makeAudit();
      await callTool(
        makeService({ audit, companyRepo: makeCompanyRepo(null) }),
        'remember',
        { roleId: ROLE_ID, companyId: COMPANY_ID, content: 'x' },
      );
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        AuditEventType.StateChange,
        expect.anything(),
      );
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
