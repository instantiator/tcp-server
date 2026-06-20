import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpCompany,
  LcpRole,
  LlmConfig,
} from '@lcp/shared';
import { AIMessage } from '@langchain/core/messages';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { StateGraph } from '@langchain/langgraph';
import { AgentLoopService } from './agent-loop.service';
import { AgentRegistryService } from '../registry/agent-registry.service';
import * as factory from '../llm/llm-factory';

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent, AuditEvent];

// Returns a compiled-graph stub whose streamEvents yields the given events
function makeStubGraph(
  events: Array<Record<string, unknown>> = [],
  throwError?: Error,
) {
  return {
    streamEvents: jest.fn().mockImplementation(() => ({
      // Return an explicit async-iterable object to avoid jest generator wrapping quirks
      // eslint-disable-next-line @typescript-eslint/require-await
      [Symbol.asyncIterator]: async function* () {
        if (throwError) throw throwError;
        for (const ev of events) yield ev;
      },
    })),
  };
}

const SUCCESS_EVENTS = [
  {
    event: 'on_chat_model_start',
    name: 'ChatOpenAI',
    data: { input: { messages: [] } },
  },
  {
    event: 'on_chat_model_end',
    name: 'agent',
    data: { output: new AIMessage('Here is my analysis.') },
  },
];

jest.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: {
    fromConnString: jest.fn().mockReturnValue({
      setup: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('@langchain/langgraph', () => {
  const actual = jest.requireActual<typeof import('@langchain/langgraph')>(
    '@langchain/langgraph',
  );
  return {
    ...actual,
    StateGraph: jest.fn().mockImplementation(() => ({
      addNode: jest.fn().mockReturnThis(),
      addEdge: jest.fn().mockReturnThis(),
      compile: jest.fn().mockReturnValue(makeStubGraph(SUCCESS_EVENTS)),
    })),
  };
});

describe('AgentLoopService', () => {
  let service: AgentLoopService;
  let registry: AgentRegistryService;
  let agentRepo: Repository<LcpAgent>;
  let roleRepo: Repository<LcpRole>;
  let companyRepo: Repository<LcpCompany>;
  let auditRepo: Repository<AuditEvent>;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(factory, 'buildChatModel')
      .mockReturnValue({} as ReturnType<typeof factory.buildChatModel>);

    const testingModule: TestingModule = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'better-sqlite3',
          database: ':memory:',
          entities: ALL_ENTITIES,
          synchronize: true,
        }),
        TypeOrmModule.forFeature(ALL_ENTITIES),
      ],
      providers: [
        AgentLoopService,
        AgentRegistryService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('postgres://localhost/test'),
          },
        },
      ],
    }).compile();

    service = testingModule.get(AgentLoopService);
    registry = testingModule.get(AgentRegistryService);
    agentRepo = testingModule.get(getRepositoryToken(LcpAgent));
    roleRepo = testingModule.get(getRepositoryToken(LcpRole));
    companyRepo = testingModule.get(getRepositoryToken(LcpCompany));
    auditRepo = testingModule.get(getRepositoryToken(AuditEvent));
  });

  afterEach(async () => {
    await auditRepo.clear();
    await agentRepo.clear();
    await roleRepo.clear();
    await companyRepo.clear();
    jest.clearAllMocks();
    jest
      .spyOn(factory, 'buildChatModel')
      .mockReturnValue({} as ReturnType<typeof factory.buildChatModel>);
    // Reset the StateGraph compile mock to the success graph for each test
    jest.mocked(StateGraph).mockImplementation(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest.fn().mockReturnValue(makeStubGraph(SUCCESS_EVENTS)),
        }) as unknown as InstanceType<typeof StateGraph>,
    );
  });

  async function seedAgentAndRole(
    opts: {
      llmConfig?: LlmConfig;
      companyLlmDefault?: LlmConfig;
    } = {
      llmConfig: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        apiKeyEnvVar: 'LM_STUDIO_API_KEY',
      },
    },
  ) {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'acme',
        name: 'ACME',
        llmDefault: opts.companyLlmDefault,
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        name: 'analyst',
        description: 'Analyses.',
        llmConfig: opts.llmConfig,
        systemPromptTemplate: 'You are {{name}} as of {{date}}.',
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        initialPrompt: 'Summarise the market.',
      }),
    );
    return { company, role, agent };
  }

  it('sets status to running then completed on a successful run', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
    expect(updated.threadId).toBe(agent.id);
  });

  it('writes an audit event for the LLM response', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id);

    const auditEvents = await auditRepo.findBy({ agentId: agent.id });
    const responseEvent = auditEvents.find(
      (e) => e.eventType === AuditEventType.LlmResponse,
    );
    expect(responseEvent).toBeDefined();
  });

  it('writes both LlmRequest and LlmResponse audit events with correct metadata', async () => {
    const { company, role, agent } = await seedAgentAndRole();

    await service.run(agent.id);

    const allEvents = await auditRepo.findBy({ agentId: agent.id });
    const requestEvent = allEvents.find(
      (e) => e.eventType === AuditEventType.LlmRequest,
    );
    const responseEvent = allEvents.find(
      (e) => e.eventType === AuditEventType.LlmResponse,
    );

    expect(requestEvent).toBeDefined();
    expect(responseEvent).toBeDefined();

    for (const event of [requestEvent!, responseEvent!]) {
      expect(event.companyId).toBe(company.id);
      expect(event.agentId).toBe(agent.id);
      expect(event.role).toBe(role.name);
    }
  });

  it('uses company llmDefault when role has no llmConfig', async () => {
    const { agent } = await seedAgentAndRole({
      llmConfig: undefined,
      companyLlmDefault: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        apiKeyEnvVar: 'LM_STUDIO_API_KEY',
      },
    });

    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
  });

  it('fails the agent when neither role nor company has an LLM config', async () => {
    const { agent } = await seedAgentAndRole({
      llmConfig: undefined,
      companyLlmDefault: undefined,
    });

    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
  });

  it('deregisters the agent from the registry after the run', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id);

    expect(registry.isRunning(agent.id)).toBe(false);
  });

  it('sets status to failed and saves a state_change audit event on LLM error', async () => {
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest
            .fn()
            .mockReturnValue(
              makeStubGraph([], new Error('LLM connection refused')),
            ),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();

    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);

    const stateEvent = await auditRepo.findOneBy({
      agentId: agent.id,
      eventType: AuditEventType.StateChange,
    });
    expect(stateEvent).not.toBeNull();
  });

  it('does nothing when the agent id does not exist', async () => {
    await expect(service.run('no-such-id')).resolves.not.toThrow();
  });

  it('completes when many non-LLM chain events precede the model response', async () => {
    // Regression: MAX_ITERATIONS must count on_chat_model_start, not all events.
    // 20 on_chain_start events followed by a model response would have triggered
    // the old "iterations > MAX_ITERATIONS" abort and marked the agent failed.
    const manyChainEvents = Array.from({ length: 20 }, (_, i) => ({
      event: 'on_chain_start',
      name: `node_${i}`,
      data: {},
    }));
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest
            .fn()
            .mockReturnValue(
              makeStubGraph([...manyChainEvents, ...SUCCESS_EVENTS]),
            ),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();
    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
  });

  it('aborts with failed/max_iterations when more than 10 LLM calls are made', async () => {
    const elevenModelStarts = Array.from({ length: 11 }, () => ({
      event: 'on_chat_model_start',
      name: 'ChatOpenAI',
      data: { input: {} },
    }));
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest.fn().mockReturnValue(makeStubGraph(elevenModelStarts)),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();
    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);

    const stateEvent = await auditRepo.findOneBy({
      agentId: agent.id,
      eventType: AuditEventType.StateChange,
    });
    expect(stateEvent?.payload).toMatchObject({ reason: 'max_iterations' });
  });
});
