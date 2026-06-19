import { TestingModule, Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
} from './index';

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent, AuditEvent];

let testingModule: TestingModule;
let companies: Repository<LcpCompany>;
let roles: Repository<LcpRole>;
let agents: Repository<LcpAgent>;
let events: Repository<AuditEvent>;

beforeAll(async () => {
  testingModule = await Test.createTestingModule({
    imports: [
      TypeOrmModule.forRoot({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ALL_ENTITIES,
        synchronize: true,
      }),
      TypeOrmModule.forFeature(ALL_ENTITIES),
    ],
  }).compile();

  companies = testingModule.get(getRepositoryToken(LcpCompany));
  roles = testingModule.get(getRepositoryToken(LcpRole));
  agents = testingModule.get(getRepositoryToken(LcpAgent));
  events = testingModule.get(getRepositoryToken(AuditEvent));
});

afterAll(async () => {
  await testingModule.close();
});

afterEach(async () => {
  // Delete in FK-safe order
  await events.clear();
  await agents.clear();
  await roles.clear();
  await companies.clear();
});

async function seedCompany() {
  return companies.save(companies.create({ slug: 'acme', name: 'ACME' }));
}

async function seedRole(companyId: string) {
  return roles.save(
    roles.create({
      companyId,
      name: 'analyst',
      description: 'Analyses data.',
      llmConfig: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        baseUrl: 'http://localhost:1234/v1',
      },
      systemPromptTemplate: 'You are {{name}}.',
    }),
  );
}

describe('LcpRole entity', () => {
  it('persists a role with JSONB llmConfig and array-field defaults', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);

    const found = await roles.findOneByOrFail({ id: role.id });
    expect(found.name).toBe('analyst');
    expect(found.llmConfig.provider).toBe('lm-studio');
    expect(found.knowledgeDomains).toEqual([]);
    expect(found.mcpServerList).toEqual([]);
  });

  it('persists knowledgeDomains and mcpServerList when supplied', async () => {
    const company = await seedCompany();
    const role = await roles.save(
      roles.create({
        companyId: company.id,
        name: 'planner',
        description: 'Plans tasks.',
        llmConfig: {
          provider: 'openai',
          model: 'gpt-4o',
          apiKeyEnvVar: 'OPENAI_API_KEY',
        },
        systemPromptTemplate: 'Plan it.',
        knowledgeDomains: ['finance', 'strategy'],
        mcpServerList: ['storage', 'memory'],
      }),
    );

    const found = await roles.findOneByOrFail({ id: role.id });
    expect(found.knowledgeDomains).toEqual(['finance', 'strategy']);
    expect(found.mcpServerList).toEqual(['storage', 'memory']);
  });
});

describe('LcpAgent entity', () => {
  it('creates an agent with default status idle and null threadId', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Summarise the market.',
      }),
    );

    const found = await agents.findOneByOrFail({ id: agent.id });
    expect(found.status).toBe(AgentStatus.Idle);
    expect(found.threadId).toBeNull();
  });

  it('sets createdAt and updatedAt timestamps on creation', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Go.',
      }),
    );

    expect(agent.createdAt).toBeInstanceOf(Date);
    expect(agent.updatedAt).toBeInstanceOf(Date);
  });

  it('accepts all valid AgentStatus values', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);

    for (const status of Object.values(AgentStatus)) {
      const agent = await agents.save(
        agents.create({
          companyId: company.id,
          roleId: role.id,
          initialPrompt: 'test',
          status,
        }),
      );
      const found = await agents.findOneByOrFail({ id: agent.id });
      expect(found.status).toBe(status);
      await agents.delete(agent.id);
    }
  });

  it('persists a threadId and status update', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Go.',
      }),
    );
    await agents.update(agent.id, {
      threadId: agent.id,
      status: AgentStatus.Running,
    });

    const found = await agents.findOneByOrFail({ id: agent.id });
    expect(found.threadId).toBe(agent.id);
    expect(found.status).toBe(AgentStatus.Running);
  });
});

describe('AuditEvent entity', () => {
  it('saves all AuditEventType values with a JSONB payload', async () => {
    const company = await seedCompany();

    for (const eventType of Object.values(AuditEventType)) {
      const event = await events.save(
        events.create({
          companyId: company.id,
          role: 'analyst',
          agentId: null,
          eventType,
          payload: { test: true, type: eventType },
        }),
      );
      const found = await events.findOneByOrFail({ id: event.id });
      expect(found.eventType).toBe(eventType);
      expect(found.payload).toEqual({ test: true, type: eventType });
      await events.delete(event.id);
    }
  });

  it('allows a null agentId for system-level events', async () => {
    const company = await seedCompany();
    const event = await events.save(
      events.create({
        companyId: company.id,
        role: 'system',
        agentId: null,
        eventType: AuditEventType.StateChange,
        payload: { reason: 'startup' },
      }),
    );
    expect(event.agentId).toBeNull();
  });

  it('sets a timestamp automatically', async () => {
    const company = await seedCompany();
    const event = await events.save(
      events.create({
        companyId: company.id,
        role: 'analyst',
        agentId: null,
        eventType: AuditEventType.LlmRequest,
        payload: {},
      }),
    );
    expect(event.timestamp).toBeInstanceOf(Date);
  });
});
