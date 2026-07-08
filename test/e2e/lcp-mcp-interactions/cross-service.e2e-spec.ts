import {
  AuditClientService,
  CompanyUser,
  LcpCompany,
  LcpRole,
} from '@lcp/shared';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import type { AddressInfo, Server } from 'net';
import request from 'supertest';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { InteractionsToolsService } from '../../../apps/lcp-mcp-interactions/src/mcp/interactions-tools.service';
import { AppModule } from '../../../apps/lcp-server/src/app.module';
import { makeTestJwt } from '../helpers/test-jwt';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

/**
 * Real network round-trip from lcp-mcp-interactions' tool handlers to a live
 * lcp-server instance — the one layer no other test tier exercises. Unit
 * tests mock axios, the MCP e2e spec only covers the protocol handshake, and
 * agent-loop integration tests stub McpClientService entirely, so a client
 * calling a URL that doesn't match any real lcp-server route (or using the
 * wrong auth header) would pass everywhere except here.
 */
async function callTool(
  service: InteractionsToolsService,
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
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool '${toolName}' not found`);
  const result = await tool.handler(args);
  return result.content[0].text;
}

describe('lcp-mcp-interactions -> lcp-server (cross-service e2e)', () => {
  let app: INestApplication<App>;
  let baseUrl: string;
  let companyRepo: Repository<LcpCompany>;
  let roleRepo: Repository<LcpRole>;
  let userRepo: Repository<CompanyUser>;
  let tools: InteractionsToolsService;
  let jwt: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await app.listen(0);
    const address: AddressInfo | string | null = (
      app.getHttpServer() as Server
    ).address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected app to listen on a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;

    companyRepo = moduleFixture.get(getRepositoryToken(LcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(LcpRole));
    userRepo = moduleFixture.get(getRepositoryToken(CompanyUser));
    jwt = makeTestJwt();

    const config = {
      getOrThrow: (key: string) => {
        if (key === 'LCP_SERVER_URL') return baseUrl;
        if (key === 'LCP_STORAGE_URL') return 'http://localhost:3010';
        if (key === 'INTERNAL_API_KEY') return INTERNAL_KEY;
        throw new Error(`Unexpected config key requested: ${key}`);
      },
    } as unknown as ConfigService;
    const audit = { record: jest.fn() } as unknown as AuditClientService;
    tools = new InteractionsToolsService(audit, config);
  });

  afterAll(() => app.close());

  afterEach(async () => {
    await userRepo.createQueryBuilder().delete().execute();
    await roleRepo.createQueryBuilder().delete().execute();
    await companyRepo.createQueryBuilder().delete().execute();
  });

  async function createCompany(): Promise<LcpCompany> {
    await request(app.getHttpServer())
      .post('/api/company')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        slug: 'cross-service-co',
        name: 'Cross-Service Corp',
        description: 'Fixture company for cross-service e2e tests.',
      });
    return companyRepo.findOneByOrFail({ slug: 'cross-service-co' });
  }

  async function createRole(companyId: UUID): Promise<LcpRole> {
    const res = await request(app.getHttpServer())
      .post('/api/role')
      .set('Authorization', `Bearer ${jwt}`)
      .send({
        companyId,
        slug: 'analyst',
        name: 'analyst',
        description: 'Analyses things.',
        llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
      })
      .expect(201);
    return res.body as LcpRole;
  }

  async function createCompanyUser(companyId: UUID): Promise<CompanyUser> {
    const res = await request(app.getHttpServer())
      .post(`/api/company/${companyId}/users`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ identifier: 'alice@example.com', memberType: 'owner' })
      .expect(201);
    return res.body as CompanyUser;
  }

  describe('list_available_contacts', () => {
    it("kind: 'roles' returns the real roles for the company over the wire", async () => {
      const company = await createCompany();
      await createRole(company.id);

      const text = await callTool(tools, 'list_available_contacts', {
        companyId: company.id,
        kind: 'roles',
      });

      expect(text).not.toContain('Error');
      expect(text).toContain('analyst');
    });

    it("kind: 'roles' returns an empty list for a company with no roles", async () => {
      const company = await createCompany();

      const text = await callTool(tools, 'list_available_contacts', {
        companyId: company.id,
        kind: 'roles',
      });

      expect(text).not.toContain('Error');
      expect(JSON.parse(text)).toEqual([]);
    });

    it("kind: 'users' returns the real users for the company over the wire", async () => {
      const company = await createCompany();
      await createCompanyUser(company.id);

      const text = await callTool(tools, 'list_available_contacts', {
        companyId: company.id,
        kind: 'users',
      });

      expect(text).not.toContain('Error');
      expect(text).toContain('alice@example.com');
    });

    it('defaults to both, returning real users and roles for the company in one call', async () => {
      const company = await createCompany();
      await createRole(company.id);
      await createCompanyUser(company.id);

      const text = await callTool(tools, 'list_available_contacts', {
        companyId: company.id,
      });

      expect(text).not.toContain('Error');
      expect(text).toContain('analyst');
      expect(text).toContain('alice@example.com');
    });
  });
});
