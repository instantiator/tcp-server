import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UUID } from 'crypto';
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
  return companies.save(
    companies.create({
      slug: 'acme',
      name: 'ACME',
      description: 'A Company that Makes Everything',
    }),
  );
}

async function seedRole(companyId: UUID) {
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

describe('LcpCompany entity', () => {
  it('persists llmDefault as JSONB and retrieves it correctly', async () => {
    const company = await companies.save(
      companies.create({
        slug: 'llm-co',
        name: 'LLM Co',
        description: 'LLM Company',
        llmDefault: {
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'OPENAI_API_KEY',
        },
      }),
    );
    const found = await companies.findOneByOrFail({ id: company.id });
    expect(found.llmDefault?.provider).toBe('openai');
    expect(found.llmDefault?.model).toBe('gpt-4o');
  });

  it('allows a company with no llmDefault', async () => {
    const company = await companies.save(
      companies.create({
        slug: 'plain-co',
        name: 'Plain Co',
        description: 'A plain company',
      }),
    );
    const found = await companies.findOneByOrFail({ id: company.id });
    expect(found.llmDefault).toBeNull();
  });
});

describe('LcpRole entity', () => {
  it('persists a role with JSONB llmConfig and array-field defaults', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);

    const found = await roles.findOneByOrFail({ id: role.id });
    expect(found.name).toBe('analyst');
    expect(found.llmConfig!.provider).toBe('lm-studio');
    expect(found.knowledgeDomains).toEqual([]);
    expect(found.mcpServerList).toEqual([]);
  });

  it('allows a role with null llmConfig when the company provides a default', async () => {
    const company = await companies.save(
      companies.create({
        slug: 'default-llm',
        name: 'Default LLM Co',
        description: 'A default company',
        llmDefault: { provider: 'openai', model: 'gpt-4o' },
      }),
    );
    const role = await roles.save(
      roles.create({
        companyId: company.id,
        name: 'inheritor',
        description: 'Uses company default.',
        systemPromptTemplate: 'You are {{name}}.',
      }),
    );
    const found = await roles.findOneByOrFail({ id: role.id });
    expect(found.llmConfig).toBeNull();
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
          apiKey: 'OPENAI_API_KEY',
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
