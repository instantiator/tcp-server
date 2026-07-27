import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { Repository } from 'typeorm';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
} from './index';

const ALL_ENTITIES = [
  TcpCompany,
  TcpRole,
  TcpAgent,
  TcpTask,
  TcpAssignment,
  AuditEvent,
];

let testingModule: TestingModule;
let companies: Repository<TcpCompany>;
let roles: Repository<TcpRole>;
let agents: Repository<TcpAgent>;
let events: Repository<AuditEvent>;
let tasks: Repository<TcpTask>;
let assignments: Repository<TcpAssignment>;

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

  companies = testingModule.get(getRepositoryToken(TcpCompany));
  roles = testingModule.get(getRepositoryToken(TcpRole));
  agents = testingModule.get(getRepositoryToken(TcpAgent));
  events = testingModule.get(getRepositoryToken(AuditEvent));
  tasks = testingModule.get(getRepositoryToken(TcpTask));
  assignments = testingModule.get(getRepositoryToken(TcpAssignment));
});

afterAll(async () => {
  await testingModule.close();
});

afterEach(async () => {
  // Delete in FK-safe order
  await events.clear();
  await assignments.clear();
  await tasks.clear();
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
      slug: 'analyst',
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

/** Seeds an orphan implement-mode assignment for the agent's mandatory FK. */
async function seedAssignment(companyId: UUID, roleId: UUID) {
  return assignments.save(
    assignments.create({
      taskId: null,
      companyId,
      roleId,
      mode: 'implement',
      prompt: 'Do it.',
      status: 'in-progress',
    }),
  );
}

describe('TcpCompany entity', () => {
  it('persists llmConfig as JSONB and retrieves it correctly', async () => {
    const company = await companies.save(
      companies.create({
        slug: 'llm-co',
        name: 'LLM Co',
        description: 'LLM Company',
        llmConfig: {
          provider: 'openai',
          model: 'gpt-4o',
          apiKey: 'OPENAI_API_KEY',
        },
      }),
    );
    const found = await companies.findOneByOrFail({ id: company.id });
    expect(found.llmConfig?.provider).toBe('openai');
    expect(found.llmConfig?.model).toBe('gpt-4o');
  });

  it('allows a company with no llmConfig', async () => {
    const company = await companies.save(
      companies.create({
        slug: 'plain-co',
        name: 'Plain Co',
        description: 'A plain company',
      }),
    );
    const found = await companies.findOneByOrFail({ id: company.id });
    expect(found.llmConfig).toBeNull();
  });
});

describe('TcpRole entity', () => {
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
        llmConfig: { provider: 'openai', model: 'gpt-4o' },
      }),
    );
    const role = await roles.save(
      roles.create({
        companyId: company.id,
        slug: 'inheritor',
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
        slug: 'planner',
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

describe('TcpAgent entity', () => {
  it('creates an agent with default status idle and null threadId', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const assignment = await seedAssignment(company.id, role.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
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
    const assignment = await seedAssignment(company.id, role.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
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
      const assignment = await seedAssignment(company.id, role.id);
      const agent = await agents.save(
        agents.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: assignment.id,
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
    const assignment = await seedAssignment(company.id, role.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
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

describe('TcpCompany.plannerRoleId', () => {
  it('allows a null plannerRoleId', async () => {
    const company = await seedCompany();
    const found = await companies.findOneByOrFail({ id: company.id });
    expect(found.plannerRoleId).toBeNull();
  });

  it('persists a plannerRoleId pointing at one of the company roles', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    await companies.update(company.id, { plannerRoleId: role.id });
    const found = await companies.findOneByOrFail({ id: company.id });
    expect(found.plannerRoleId).toBe(role.id);
  });
});

describe('TcpTask entity', () => {
  it('creates a task with default status ready and empty array defaults', async () => {
    const company = await seedCompany();
    const task = await tasks.save(
      tasks.create({
        companyId: company.id,
        request: 'Write a report',
        shortcode: '000',
      }),
    );
    const found = await tasks.findOneByOrFail({ id: task.id });
    expect(found.status).toBe('ready');
    expect(found.materials).toEqual([]);
    expect(found.expected).toEqual([]);
    expect(found.completed).toBeNull();
    expect(found.plannerRoleId).toBeNull();
  });

  it('persists materials/expected artifact arrays', async () => {
    const company = await seedCompany();
    const task = await tasks.save(
      tasks.create({
        companyId: company.id,
        request: 'Write a report',
        shortcode: '000',
        materials: [{ type: 'inline-text', value: 'context notes' }],
        expected: [{ type: 'task-completed-path', value: 'report.md' }],
      }),
    );
    const found = await tasks.findOneByOrFail({ id: task.id });
    expect(found.materials).toEqual([
      { type: 'inline-text', value: 'context notes' },
    ]);
    expect(found.expected).toEqual([
      { type: 'task-completed-path', value: 'report.md' },
    ]);
  });

  it('persists an explicit plannerRoleId', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const task = await tasks.save(
      tasks.create({
        companyId: company.id,
        request: 'Write a report',
        shortcode: '000',
        plannerRoleId: role.id,
      }),
    );
    const found = await tasks.findOneByOrFail({ id: task.id });
    expect(found.plannerRoleId).toBe(role.id);
  });
});

describe('TcpAssignment entity', () => {
  it('creates an orphan assignment with default mode implement and status ready', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const assignment = await assignments.save(
      assignments.create({
        companyId: company.id,
        roleId: role.id,
        prompt: 'Consult on X',
      }),
    );
    const found = await assignments.findOneByOrFail({ id: assignment.id });
    expect(found.taskId).toBeNull();
    expect(found.mode).toBe('implement');
    expect(found.status).toBe('ready');
    expect(found.orderIndex).toBeNull();
    expect(found.agentId).toBeNull();
    expect(found.qaAttempts).toBe(0);
    expect(found.materials).toEqual([]);
    expect(found.expected).toEqual([]);
    expect(found.prepared).toEqual([]);
    expect(found.approved).toEqual([]);
  });

  it('creates a task-scoped implement assignment with an orderIndex', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const task = await tasks.save(
      tasks.create({
        companyId: company.id,
        request: 'Write a report',
        shortcode: '000',
      }),
    );
    const assignment = await assignments.save(
      assignments.create({
        companyId: company.id,
        taskId: task.id,
        roleId: role.id,
        mode: 'implement',
        orderIndex: 0,
        prompt: 'Draft the report',
      }),
    );
    const found = await assignments.findOneByOrFail({ id: assignment.id });
    expect(found.taskId).toBe(task.id);
    expect(found.orderIndex).toBe(0);
  });

  it('persists a qa-mode assignment with a targetAssignmentId', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const task = await tasks.save(
      tasks.create({
        companyId: company.id,
        request: 'Write a report',
        shortcode: '000',
      }),
    );
    const target = await assignments.save(
      assignments.create({
        companyId: company.id,
        taskId: task.id,
        roleId: role.id,
        mode: 'implement',
        orderIndex: 0,
        prompt: 'Draft the report',
      }),
    );
    const qa = await assignments.save(
      assignments.create({
        companyId: company.id,
        taskId: task.id,
        roleId: role.id,
        mode: 'qa',
        targetAssignmentId: target.id,
        prompt: 'Review the draft',
      }),
    );
    const found = await assignments.findOneByOrFail({ id: qa.id });
    expect(found.mode).toBe('qa');
    expect(found.targetAssignmentId).toBe(target.id);
    expect(found.orderIndex).toBeNull();
  });

  it('nulls agentId when the referenced agent is deleted', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const agentAssignment = await seedAssignment(company.id, role.id);
    const agent = await agents.save(
      agents.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: agentAssignment.id,
        initialPrompt: 'Go.',
      }),
    );
    const assignment = await assignments.save(
      assignments.create({
        companyId: company.id,
        roleId: role.id,
        prompt: 'Consult on X',
        agentId: agent.id,
      }),
    );
    await agents.delete(agent.id);
    const found = await assignments.findOneByOrFail({ id: assignment.id });
    expect(found.agentId).toBeNull();
  });

  it('cascades delete from its task', async () => {
    const company = await seedCompany();
    const role = await seedRole(company.id);
    const task = await tasks.save(
      tasks.create({
        companyId: company.id,
        request: 'Write a report',
        shortcode: '000',
      }),
    );
    const assignment = await assignments.save(
      assignments.create({
        companyId: company.id,
        taskId: task.id,
        roleId: role.id,
        mode: 'implement',
        orderIndex: 0,
        prompt: 'Draft the report',
      }),
    );
    await tasks.delete(task.id);
    const found = await assignments.findOneBy({ id: assignment.id });
    expect(found).toBeNull();
  });
});
