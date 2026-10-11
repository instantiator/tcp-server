import {
  AgentStatus,
  InternalApiClient,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from '@tcp/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { AddressInfo, Server } from 'net';
import { App } from 'supertest/types';
import { Repository } from 'typeorm';
import { ResourceToolsService } from '../../../apps/tcp-mcp-storage/src/mcp/resource-tools.service';
import { StorageApiService } from '../../../apps/tcp-mcp-storage/src/mcp/storage-api.service';
import { AppModule } from '../../../apps/tcp-server/src/app.module';

const INTERNAL_KEY = process.env.INTERNAL_API_KEY ?? 'e2e-test-internal-key';

/**
 * The company-resource tools against a live tcp-server, real storage and a
 * seeded agent: a chat agent changes the live resources directly, an implement
 * agent on a task writes a draft under its assignment's `working/resources/`.
 * Unit tests fake the storage layer, so only here do the scope, the key
 * prefixes and the real write/copy/append/replace endpoints meet.
 */
describe('tcp-mcp-storage resource tools -> tcp-server (e2e)', () => {
  let app: INestApplication<App>;
  let api: StorageApiService;
  let tools: ResourceToolsService;

  let companyRepo: Repository<TcpCompany>;
  let roleRepo: Repository<TcpRole>;
  let taskRepo: Repository<TcpTask>;
  let assignmentRepo: Repository<TcpAssignment>;
  let agentRepo: Repository<TcpAgent>;

  let company: TcpCompany;
  let chatAgent: TcpAgent;
  let implementAgent: TcpAgent;
  let draftPrefix: string;
  let livePrefix: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    // Listening, not just init() — see agent.e2e-spec.ts for why.
    await app.listen(0);
    const address: AddressInfo | string | null = (
      app.getHttpServer() as Server
    ).address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected app to listen on a TCP port');
    }
    const config = {
      getOrThrow: (key: string) => {
        if (key === 'TCP_SERVER_URL') return `http://127.0.0.1:${address.port}`;
        if (key === 'INTERNAL_API_KEY') return INTERNAL_KEY;
        throw new Error(`Unexpected config key requested: ${key}`);
      },
    } as unknown as ConfigService;
    api = new StorageApiService(new InternalApiClient(config));
    tools = new ResourceToolsService(api);

    companyRepo = moduleFixture.get(getRepositoryToken(TcpCompany));
    roleRepo = moduleFixture.get(getRepositoryToken(TcpRole));
    taskRepo = moduleFixture.get(getRepositoryToken(TcpTask));
    assignmentRepo = moduleFixture.get(getRepositoryToken(TcpAssignment));
    agentRepo = moduleFixture.get(getRepositoryToken(TcpAgent));

    company = await companyRepo.save(
      companyRepo.create({
        slug: `resources-co-${Date.now()}`,
        name: 'Resources Co',
        description: 'Fixture company for the resource tools e2e.',
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'clerk',
        name: 'clerk',
        description: 'Keeps the books.',
      }),
    );
    const task = await taskRepo.save(
      taskRepo.create({
        companyId: company.id,
        request: 'Update the price list.',
        shortcode: '000',
        status: 'in-progress',
      }),
    );

    const seed = async (fields: Partial<TcpAssignment>): Promise<TcpAgent> => {
      const assignment = await assignmentRepo.save(
        assignmentRepo.create({
          companyId: company.id,
          roleId: role.id,
          prompt: 'Work.',
          status: 'in-progress',
          ...fields,
        }),
      );
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: assignment.id,
          status: AgentStatus.Running,
          initialPrompt: 'Work.',
        }),
      );
      await assignmentRepo.update(assignment.id, { agentId: agent.id });
      return agent;
    };
    chatAgent = await seed({ mode: 'chat', taskId: null });
    implementAgent = await seed({
      mode: 'implement',
      taskId: task.id,
      orderIndex: 0,
    });

    livePrefix = `${company.slug}/resources/`;
    draftPrefix = `${company.slug}/tasks/${task.id}/assignments/0/working/resources/`;
  });

  afterAll(async () => {
    await agentRepo.delete({ companyId: company.id });
    await assignmentRepo.delete({ companyId: company.id });
    await taskRepo.delete({ companyId: company.id });
    await roleRepo.delete({ companyId: company.id });
    await companyRepo.delete({ id: company.id });
    await app.close();
  });

  /** Calls a registered tool directly, bypassing the transport layer. */
  async function callTool(
    name: string,
    agent: TcpAgent,
    args: Record<string, unknown>,
  ): Promise<string> {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    tools.register(server);
    const registered = (server as unknown as { _registeredTools: unknown })
      ._registeredTools as Record<
      string,
      {
        handler: (
          args: Record<string, unknown>,
        ) => Promise<{ content: { text: string }[] }>;
      }
    >;
    const result = await registered[name].handler({
      agentId: agent.id,
      ...args,
    });
    return result.content[0].text;
  }

  async function keysUnder(prefix: string): Promise<string[]> {
    const { entries } = await api.post<{ entries: { key: string }[] }>('list', {
      prefix,
      all: true,
    });
    return entries.map((e) => e.key);
  }

  it('a chat agent writes straight to the live resources, then reads and lists them', async () => {
    const written = await callTool('write_resource', chatAgent, {
      path: 'invoices/INV-0042.md',
      content: '# Invoice 42\n',
    });
    expect(written).toContain("Created resource 'invoices/INV-0042.md'.");
    expect(written).not.toContain('draft');
    expect(await keysUnder(livePrefix)).toEqual([
      `${livePrefix}invoices/INV-0042.md`,
    ]);

    expect(
      await callTool('read_resource', chatAgent, {
        path: 'invoices/INV-0042.md',
      }),
    ).toBe('# Invoice 42\n');
    expect(await callTool('list_resources', chatAgent, {})).toBe(
      'resources/\n  invoices/\n    INV-0042.md',
    );
  });

  it('an implement agent sees the live file, and its changes land in its own draft', async () => {
    expect(
      await callTool('read_resource', implementAgent, {
        path: 'invoices/INV-0042.md',
      }),
    ).toBe('# Invoice 42\n');

    const appended = await callTool('append_resource', implementAgent, {
      path: 'invoices/INV-0042.md',
      content: 'Paid.\n',
    });
    expect(appended).toContain("Appended to resource 'invoices/INV-0042.md'.");
    expect(appended).toContain("It's a draft");

    // The live file is untouched; the draft holds the copy plus the addition.
    expect(
      await callTool('read_resource', chatAgent, {
        path: 'invoices/INV-0042.md',
      }),
    ).toBe('# Invoice 42\n');
    expect(await keysUnder(draftPrefix)).toEqual([
      `${draftPrefix}invoices/INV-0042.md`,
    ]);
    expect(
      await callTool('read_resource', implementAgent, {
        path: 'invoices/INV-0042.md',
      }),
    ).toBe('# Invoice 42\nPaid.\n');

    expect(
      await callTool('replace_in_resource', implementAgent, {
        path: 'invoices/INV-0042.md',
        find: 'Paid',
        replace: 'Settled',
      }),
    ).toContain("Replaced 1 occurrence(s) in resource 'invoices/INV-0042.md'.");
  });

  it('an implement agent writing a new file shows it as a draft in the tree', async () => {
    await callTool('write_resource', implementAgent, {
      path: 'price-list.md',
      content: '# Prices\n',
    });
    expect(await keysUnder(draftPrefix)).toContain(
      `${draftPrefix}price-list.md`,
    );
    expect(await keysUnder(livePrefix)).not.toContain(
      `${livePrefix}price-list.md`,
    );
    const tree = await callTool('list_resources', implementAgent, {});
    expect(tree).toContain('price-list.md (draft)');
    expect(tree).toContain('INV-0042.md (draft)');
  });

  it('corrects a wrong path with the files that exist', async () => {
    expect(
      await callTool('read_resource', chatAgent, {
        path: 'invoices/INV-0042.txt',
      }),
    ).toContain("Did you mean 'invoices/INV-0042.md'?");
  });
});
