// lcp-mcp-memory requires a real Postgres connection, provisioned by the e2e
// global setup — DATABASE_URL is always a real postgres URL.
import { TcpCompany, TcpRole } from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { AppModule } from '../../../apps/lcp-mcp-memory/src/app.module';
import { requireEnv } from '../../support/require-env';

const STUB_LLM_URL = requireEnv('STUB_LLM_URL');
requireEnv('DATABASE_URL');

const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0.0.1' },
  },
};

/**
 * Calls an MCP tool over the real `/mcp` transport and returns its text
 * content. `BaseMcpController` builds its `StreamableHTTPServerTransport`
 * with `sessionIdGenerator: undefined` (stateless mode), which skips session
 * validation entirely — a standalone `tools/call` needs no preceding
 * `initialize` on the same connection, confirmed against the installed SDK
 * (`@modelcontextprotocol/sdk`)'s `validateSession`.
 *
 * The transport defaults to SSE-framed POST responses (`enableJsonResponse`
 * is never set), so the body is `event: message\ndata: {...}\n\n` rather
 * than a bare JSON object — extracted here rather than parsed as JSON directly.
 */
async function callTool(
  app: INestApplication<App>,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })
    .expect(200);

  const match = /data: (.+)/.exec(res.text);
  if (!match) throw new Error(`No SSE data event in response: ${res.text}`);
  const message = JSON.parse(match[1]) as {
    result?: { content: { type: string; text: string }[] };
    error?: { message: string };
  };
  if (message.error) {
    throw new Error(
      `Tool '${name}' returned an error: ${message.error.message}`,
    );
  }
  const text = message.result?.content[0]?.text;
  if (text === undefined) {
    throw new Error(`Tool '${name}' returned no text content: ${res.text}`);
  }
  return text;
}

describe('lcp-mcp-memory MCP endpoint (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(() => app.close());

  it('POST /mcp returns 200 for a valid initialize request', () =>
    request(app.getHttpServer())
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .send(initializeRequest)
      .expect((res) => expect([200, 202]).toContain(res.status)));

  it('GET /mcp returns 405', () =>
    request(app.getHttpServer()).get('/mcp').expect(405));

  it('DELETE /mcp returns 405', () =>
    request(app.getHttpServer()).delete('/mcp').expect(405));

  describe('tool calls (real DB round trip)', () => {
    let companyRepo: Repository<TcpCompany>;
    let roleRepo: Repository<TcpRole>;
    let companyId: UUID;
    let roleId: UUID;

    beforeAll(async () => {
      // AddMissingCompanyRoleForeignKeys1783357408218 added a real FK from
      // episodic_memory.roleId to tcp_role.id, so a real row is required —
      // McpModule only registers TcpCompany/EpisodicMemory as forFeature
      // repositories (TcpRole is connection-only, see app.module.ts), so
      // TypeOrmModule.forFeature([TcpRole]) is added here purely to expose
      // its repository for seeding, against the same connection AppModule
      // already established.
      const module: TestingModule = await Test.createTestingModule({
        imports: [AppModule, TypeOrmModule.forFeature([TcpRole])],
      }).compile();
      companyRepo = module.get(getRepositoryToken(TcpCompany));
      roleRepo = module.get(getRepositoryToken(TcpRole));

      const company = await companyRepo.save(
        companyRepo.create({
          slug: `mcp-memory-roundtrip-co-${Date.now()}`,
          name: 'MCP Memory Roundtrip Co',
          description: 'Test',
          embeddingConfig: {
            provider: 'openai',
            model: 'stub-embed',
            baseUrl: STUB_LLM_URL,
            apiKey: 'test',
          },
        }),
      );
      companyId = company.id;

      const role = await roleRepo.save(
        roleRepo.create({
          slug: 'mcp-memory-roundtrip-role',
          name: 'MCP Memory Roundtrip Role',
          description: 'Test role',
          systemPromptTemplate: 'Remember things.',
          knowledgeDomains: [],
          mcpServerList: [],
          company,
          companyId: company.id,
        }),
      );
      roleId = role.id;
    });

    afterAll(async () => {
      await roleRepo.delete({ id: roleId });
      await companyRepo.delete({ id: companyId });
    });

    it('remember stores a memory and returns its id', async () => {
      const text = await callTool(app, 'remember', {
        roleId,
        companyId,
        content: 'The office wifi password is stored in the ops vault.',
      });

      expect(text).toMatch(/Memory stored \(id: [0-9a-f-]{36}\)/);
    });

    it('recall finds a memory matching stored content', async () => {
      // stub-llm embeddings are deterministic-but-not-semantic (identical
      // text -> identical vector, cosine ~1.0) — an exact-content query is
      // the reliable way to clear the tools' 0.5 similarity floor.
      const content = 'Deploys require two reviewer approvals.';
      await callTool(app, 'remember', { roleId, companyId, content });

      const text = await callTool(app, 'recall', {
        roleId,
        companyId,
        query: content,
      });

      expect(text).toContain(content);
      expect(text).toContain('source: episodic');
    });

    it('search_knowledge never returns episodic memory, only knowledge_chunk rows', async () => {
      const content = 'The kitchen fridge is cleaned out every Friday.';
      await callTool(app, 'remember', { roleId, companyId, content });

      const text = await callTool(app, 'search_knowledge', {
        roleId,
        companyId,
        query: content,
      });

      // No knowledge_chunk rows exist for this role/company, so the just-stored
      // episodic memory must not leak through — proving the real UNION/filter
      // SQL excludes it, not just the mocked-DB unit test in
      // memory-tools.service.spec.ts.
      expect(text).not.toContain(content);
    });
  });
});
