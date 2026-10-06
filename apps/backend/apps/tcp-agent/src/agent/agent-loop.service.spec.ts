import {
  AIMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { MessagesAnnotation, StateGraph } from '@langchain/langgraph';
import {
  AgentStatus,
  AuditClientService,
  AuditEventType,
  ContextManagerService,
  KnowledgeRetrievalService,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  LlmConfig,
  MODE_PROMPTS,
  renderTemplate,
} from '@tcp/shared';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import * as factory from '@tcp/shared/llm/llm-factory';
import { McpClientService } from '@tcp/shared';
import { AgentRagService } from '../rag/agent-rag.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { agentPrompts } from '../agent-prompts';
import { AgentEventPublisherService } from './agent-event-publisher.service';
import { AgentLoopService } from './agent-loop.service';
import { SupervisedTurnService } from './supervised-turn.service';
import { SpendGateService } from './spend-gate.service';
import { InitialStateService } from './initial-state.service';
import { AgentLoopEventRecorder } from './loop-events.service';
import { AgentRunEnvironmentService } from './run-environment.service';
import { AgentRunStatusService } from './run-status.service';

const ALL_ENTITIES = [TcpCompany, TcpRole, TcpAgent, TcpTask, TcpAssignment];

// Returns a compiled-graph stub whose streamEvents yields the given events.
// getState defaults to next: [] (natural end) — these tests exercise one
// streamEvents call per logical turn/reminder round, not the low-level
// interrupt/resume mechanic (covered separately by run-supervised-graph.spec.ts).
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
    getState: jest
      .fn()
      .mockResolvedValue({ values: { messages: [] }, next: [] }),
    updateState: jest.fn().mockResolvedValue({}),
  };
}

// Installs a StateGraph mock exposing the full builder chain used when tools
// are present (addConditionalEdges is only called for tool graphs) — needed
// whenever a test gives the agent a non-empty tool list, or the real
// buildAgentGraph logic throws trying to call it on the plain mock.
function mockToolGraphOnce(graph: { streamEvents: jest.Mock }) {
  jest.mocked(StateGraph).mockImplementationOnce(
    () =>
      ({
        addNode: jest.fn().mockReturnThis(),
        addEdge: jest.fn().mockReturnThis(),
        addConditionalEdges: jest.fn().mockReturnThis(),
        compile: jest.fn().mockReturnValue(graph),
      }) as unknown as InstanceType<typeof StateGraph>,
  );
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

// Mirrors SUCCESS_EVENTS but with blank content, e.g. a "thinking" model whose
// answer landed entirely in a reasoning_content field LangChain doesn't surface.
const BLANK_CONTENT_EVENTS = [
  {
    event: 'on_chat_model_start',
    name: 'ChatOpenAI',
    data: { input: { messages: [] } },
  },
  {
    event: 'on_chat_model_end',
    name: 'agent',
    data: { output: new AIMessage('') },
  },
];

// Returns a compiled-graph stub whose streamEvents yields a different event
// set on each successive call — used to simulate the run/retry sequence.
// getState defaults to next: [] (natural end) for the same reason as
// makeStubGraph above.
function makeSequentialStubGraph(
  ...eventSets: Array<Array<Record<string, unknown>>>
) {
  const streamEvents = jest.fn();
  for (const events of eventSets) {
    streamEvents.mockImplementationOnce(() => ({
      // eslint-disable-next-line @typescript-eslint/require-await
      [Symbol.asyncIterator]: async function* () {
        for (const ev of events) yield ev;
      },
    }));
  }
  const getState = jest
    .fn()
    .mockResolvedValue({ values: { messages: [] }, next: [] });
  const updateState = jest.fn().mockResolvedValue({});
  return { streamEvents, getState, updateState };
}

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
  let agentRepo: Repository<TcpAgent>;
  let assignmentRepo: Repository<TcpAssignment>;
  let roleRepo: Repository<TcpRole>;
  let companyRepo: Repository<TcpCompany>;
  let taskRepo: Repository<TcpTask>;
  let auditRecord: jest.Mock;
  let notifyComplete: jest.Mock;
  let notifyFailed: jest.Mock;
  let publishEvent: jest.Mock;
  let mcpClient: { loadTools: jest.Mock };
  let ragProvider: { hasKnowledge: jest.Mock };
  let knowledgeProvider: { retrieve: jest.Mock };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };
  let prepareContext: jest.Mock;
  let checkBudget: jest.Mock;
  let testingModule: TestingModule;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(factory, 'buildChatModel')
      .mockReturnValue({} as ReturnType<typeof factory.buildChatModel>);

    auditRecord = jest.fn();
    notifyComplete = jest.fn();
    notifyFailed = jest.fn();
    publishEvent = jest.fn();
    // Pass-through stub — most tests don't care about compaction, just that
    // the (possibly-guarded) message flows through unchanged.
    prepareContext = jest
      .fn()
      .mockImplementation((_agentId: string, message: string) =>
        Promise.resolve({ message, report: null }),
      );
    // Pass-through stub — most tests don't exercise mid-run compaction.
    checkBudget = jest
      .fn()
      .mockResolvedValue({ report: null, stillOverBudget: false });

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
      providers: [
        AgentLoopService,
        AgentRunEnvironmentService,
        InitialStateService,
        AgentRunStatusService,
        AgentLoopEventRecorder,
        SupervisedTurnService,
        // Never holds spending back here; the gate has its own spec.
        {
          provide: SpendGateService,
          useValue: { forRun: () => () => Promise.resolve(false) },
        },
        {
          provide: AuditClientService,
          useValue: { record: auditRecord, notifyComplete, notifyFailed },
        },
        {
          provide: StorageTrackingClientService,
          useValue: { patch: jest.fn() },
        },
        {
          provide: AgentEventPublisherService,
          useValue: { publish: publishEvent },
        },
        {
          provide: ContextManagerService,
          useValue: { prepare: prepareContext, checkBudget },
        },
        {
          provide: AgentRagService,
          useValue: { hasKnowledge: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: KnowledgeRetrievalService,
          useValue: { retrieve: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: McpClientService,
          useValue: { loadTools: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(undefined),
            getOrThrow: jest.fn().mockReturnValue('postgres://localhost/test'),
          },
        },
      ],
    }).compile();

    service = testingModule.get(AgentLoopService);
    agentRepo = testingModule.get(getRepositoryToken(TcpAgent));
    assignmentRepo = testingModule.get(getRepositoryToken(TcpAssignment));
    roleRepo = testingModule.get(getRepositoryToken(TcpRole));
    companyRepo = testingModule.get(getRepositoryToken(TcpCompany));
    taskRepo = testingModule.get(getRepositoryToken(TcpTask));
    mcpClient = testingModule.get(McpClientService);
    ragProvider = testingModule.get(AgentRagService);
    knowledgeProvider = testingModule.get(KnowledgeRetrievalService);
    configService = testingModule.get(ConfigService);
  });

  // Closes the better-sqlite3 DataSource this module opened. Without it the
  // connection outlives the suite, and `@nestjs/typeorm`'s connection retry —
  // an rxjs timer — can fire after Jest has torn the environment down, at
  // which point re-loading the driver throws "require after teardown".
  afterAll(async () => {
    await testingModule.close();
  });

  afterEach(async () => {
    auditRecord.mockClear();
    notifyComplete.mockClear();
    notifyFailed.mockClear();
    publishEvent.mockClear();
    prepareContext.mockClear();
    checkBudget.mockClear();
    // Agents before assignments (agent.assignmentId FK), assignments before
    // tasks (assignment.taskId FK).
    await agentRepo.clear();
    await assignmentRepo.clear();
    await taskRepo.clear();
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
      companyLlmConfig?: LlmConfig;
      systemPromptTemplate?: string;
      mode?: TcpAssignment['mode'];
      materials?: TcpAssignment['materials'];
      expected?: TcpAssignment['expected'];
    } = {
      llmConfig: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        apiKey: 'test-key',
      },
    },
  ) {
    const company = await companyRepo.save(
      companyRepo.create({
        slug: 'acme',
        name: 'ACME',
        description: 'A Company that Makes Everything',
        llmConfig: opts.companyLlmConfig,
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        slug: 'analyst',
        name: 'analyst',
        description: 'Analyses.',
        llmConfig: opts.llmConfig,
        systemPromptTemplate:
          opts.systemPromptTemplate ?? 'You are {{name}} as of {{date}}.',
      }),
    );
    // Every agent carries an assignment (orphan for this plain run).
    const assignment = await assignmentRepo.save(
      assignmentRepo.create({
        taskId: null,
        companyId: company.id,
        roleId: role.id,
        mode: opts.mode ?? 'implement',
        prompt: 'Summarise the market.',
        status: 'in-progress',
        materials: opts.materials ?? [],
        expected: opts.expected ?? [],
      }),
    );
    const agent = await agentRepo.save(
      agentRepo.create({
        companyId: company.id,
        roleId: role.id,
        assignmentId: assignment.id,
        initialPrompt: 'Summarise the market.',
      }),
    );
    await assignmentRepo.update(assignment.id, { agentId: agent.id });
    return { company, role, agent, assignment };
  }

  it('sets status to running then completed on a successful run', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
    expect(updated.threadId).toBe(agent.id);
  });

  it('stops the loop without writing output or notifying when the agent is cancelled mid-run', async () => {
    const { agent } = await seedAgentAndRole();
    // Simulates a concurrent task cancellation: the agent's status flips to
    // Cancelled (as TaskOrchestrationService.cancelTask does) partway
    // through the streamed turn, mirroring checkTerminalStatus's DB poll.
    const stubGraph = {
      streamEvents: jest.fn().mockImplementation(() => ({
        [Symbol.asyncIterator]: async function* () {
          for (const ev of SUCCESS_EVENTS) yield ev;
          await agentRepo.update(agent.id, { status: AgentStatus.Cancelled });
        },
      })),
      getState: jest
        .fn()
        .mockResolvedValue({ values: { messages: [] }, next: [] }),
      updateState: jest.fn().mockResolvedValue({}),
    };
    jest.mocked(StateGraph).mockImplementation(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest.fn().mockReturnValue(stubGraph),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Cancelled);
    expect(updated.output).toBeNull();
    expect(notifyComplete).not.toHaveBeenCalled();
    expect(notifyFailed).not.toHaveBeenCalled();
  });

  it('checks context budget before running, using the resolved window size and loaded tools', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    expect(prepareContext).toHaveBeenCalledWith(
      agent.id,
      'Summarise the market.',
      expect.anything(),
      8192, // DEFAULT_LLM_CONTEXT_WINDOW — no contextWindow set on the fixture llmConfig
      expect.anything(),
      expect.anything(),
      true, // isFirstMessage — fresh run, no replyContent
      expect.objectContaining({ id: agent.id }),
      expect.objectContaining({ name: 'analyst' }),
      [],
      { provider: 'lm-studio', model: 'qwen3-5b' },
    );
  });

  it('uses the (possibly compacted) message ContextManagerService.prepare returns, not the raw initialPrompt', async () => {
    const { agent } = await seedAgentAndRole();
    const stubGraph = makeStubGraph(SUCCESS_EVENTS);
    jest.mocked(StateGraph).mockImplementation(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest.fn().mockReturnValue(stubGraph),
        }) as unknown as InstanceType<typeof StateGraph>,
    );
    prepareContext.mockImplementationOnce(() =>
      Promise.resolve({ message: 'compacted task text', report: null }),
    );

    await service.run(agent.id, undefined, new AbortController());

    const [input] = jest.mocked(stubGraph.streamEvents).mock.calls[0] as [
      { messages: { content: string }[] },
    ];
    const contents = input.messages.map((m) => m.content);
    // The compacted prompt is now embedded in the assignment-presentation part.
    expect(
      contents.some(
        (c) => typeof c === 'string' && c.includes('compacted task text'),
      ),
    ).toBe(true);
    expect(
      contents.some(
        (c) => typeof c === 'string' && c.includes('Summarise the market.'),
      ),
    ).toBe(false);
  });

  it('records a running state_change and llm lifecycle audit rows during a successful run', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    // The non-terminal running transition is recorded as a state_change the
    // server streams live; the terminal Completed transition is recorded by
    // the server (via notifyComplete), not here.
    expect(auditRecord).toHaveBeenCalledWith(
      agent.companyId,
      expect.any(String),
      agent.id,
      AuditEventType.StateChange,
      expect.objectContaining({
        entity: 'agent',
        newStatus: AgentStatus.Running,
      }),
    );
    // The LLM request lifecycle is captured as an audit row (streamed live).
    expect(auditRecord).toHaveBeenCalledWith(
      agent.companyId,
      expect.any(String),
      agent.id,
      AuditEventType.LlmRequest,
      expect.any(Object),
    );
    expect(notifyComplete).toHaveBeenCalledWith(agent.id, expect.any(String));
  });

  it('passes the real agentId/companyId as MCP tool context, not LLM-suppliable values', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    expect(mcpClient.loadTools).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      { agentId: agent.id, companyId: agent.companyId },
    );
  });

  describe('mode-tool restriction and toolChoice wiring', () => {
    const COMPLETE_ASSIGNMENT_TOOL = {
      serverName: 'tasks',
      toolName: 'tasks__complete_assignment',
      tool: { name: 'tasks__complete_assignment' },
    };

    // The shared ConfigService mock returns undefined for every MCP env key
    // by default (see beforeAll), so resolveMcpServerUrls always resolves an
    // empty server list — fine for tests that don't care about server-name
    // filtering, but these do, so all four MCP server URLs are configured
    // for this block only.
    const MCP_URLS: Record<string, string> = {
      MCP_STORAGE_URL: 'http://storage:3010',
      MCP_MEMORY_URL: 'http://memory:3011',
      MCP_INTERACTIONS_URL: 'http://interactions:3012',
      MCP_TASKS_URL: 'http://tasks:3013',
    };
    beforeEach(() => {
      configService.get.mockImplementation((key: string) => MCP_URLS[key]);
    });
    afterEach(() => {
      configService.get.mockReturnValue(undefined);
    });

    // seedAgentAndRole's default llmConfig only applies when called with no
    // args at all (a plain default parameter) — passing any override object
    // means llmConfig must be repeated explicitly, or the role ends up with
    // none and the run fails before ever reaching MCP tool loading.
    const TEST_LLM_CONFIG: LlmConfig = {
      provider: 'lm-studio',
      model: 'qwen3-5b',
      apiKey: 'test-key',
    };

    it("excludes 'interactions' from the loaded MCP servers for a plan-mode run (serverNamesForMode wiring)", async () => {
      const { agent } = await seedAgentAndRole({
        mode: 'plan',
        llmConfig: TEST_LLM_CONFIG,
      });

      await service.run(agent.id, undefined, new AbortController());

      const [serverNames] = mcpClient.loadTools.mock.calls[0] as [string[]];
      expect(serverNames).not.toContain('interactions');
    });

    it("keeps 'interactions' among the loaded MCP servers for an implement-mode run", async () => {
      const { agent } = await seedAgentAndRole({
        mode: 'implement',
        llmConfig: TEST_LLM_CONFIG,
      });

      await service.run(agent.id, undefined, new AbortController());

      const [serverNames] = mcpClient.loadTools.mock.calls[0] as [string[]];
      expect(serverNames).toContain('interactions');
    });

    it.each(['plan', 'implement', 'qa'] as const)(
      "binds tools with toolChoice: 'required' for %s-mode runs",
      async (mode) => {
        mcpClient.loadTools.mockResolvedValueOnce([COMPLETE_ASSIGNMENT_TOOL]);
        mockToolGraphOnce(makeStubGraph(SUCCESS_EVENTS));
        const bindTools = jest.fn().mockReturnValue({});
        jest.spyOn(factory, 'buildChatModel').mockReturnValueOnce({
          bindTools,
        } as unknown as ReturnType<typeof factory.buildChatModel>);
        const { agent } = await seedAgentAndRole({
          mode,
          llmConfig: TEST_LLM_CONFIG,
        });

        await service.run(agent.id, undefined, new AbortController());

        expect(bindTools).toHaveBeenCalledWith(expect.any(Array), {
          tool_choice: 'required',
        });
      },
    );

    it('binds tools with an undefined toolChoice for a chat-mode run', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([COMPLETE_ASSIGNMENT_TOOL]);
      mockToolGraphOnce(makeStubGraph(SUCCESS_EVENTS));
      const bindTools = jest.fn().mockReturnValue({});
      jest.spyOn(factory, 'buildChatModel').mockReturnValueOnce({
        bindTools,
      } as unknown as ReturnType<typeof factory.buildChatModel>);
      const { agent } = await seedAgentAndRole({
        mode: 'chat',
        llmConfig: TEST_LLM_CONFIG,
      });

      await service.run(agent.id, undefined, new AbortController());

      expect(bindTools).toHaveBeenCalledWith(expect.any(Array), {});
    });

    it('drops memory from the loaded MCP servers and skips RAG retrieval when the role has no indexed knowledge', async () => {
      ragProvider.hasKnowledge.mockResolvedValueOnce(false);
      const { agent } = await seedAgentAndRole();

      await service.run(agent.id, undefined, new AbortController());

      const [serverNames] = mcpClient.loadTools.mock.calls[0] as [string[]];
      expect(serverNames).not.toContain('memory');
      expect(knowledgeProvider.retrieve).not.toHaveBeenCalled();
    });
  });

  it('writes an audit event for the LLM response', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    expect(auditRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      agent.id,
      AuditEventType.LlmResponse,
      expect.any(Object),
    );
  });

  it('writes both LlmRequest and LlmResponse audit events with correct metadata', async () => {
    const { company, role, agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    expect(auditRecord).toHaveBeenCalledWith(
      company.id,
      role.name,
      agent.id,
      AuditEventType.LlmRequest,
      expect.any(Object),
    );
    expect(auditRecord).toHaveBeenCalledWith(
      company.id,
      role.name,
      agent.id,
      AuditEventType.LlmResponse,
      expect.any(Object),
    );
  });

  it('uses company llmConfig when role has no llmConfig', async () => {
    const { agent } = await seedAgentAndRole({
      llmConfig: undefined,
      companyLlmConfig: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        apiKey: 'test-key',
      },
    });

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
  });

  it('fails the agent when neither role nor company has an LLM config', async () => {
    const { agent } = await seedAgentAndRole({
      llmConfig: undefined,
      companyLlmConfig: undefined,
    });

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      expect.stringContaining('No LLM config'),
    );
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

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      'LLM connection refused',
    );

    expect(auditRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      agent.id,
      AuditEventType.StateChange,
      expect.any(Object),
    );
  });

  describe('when the provider rate-limits the call', () => {
    /** A 429 shaped like the OpenAI SDK's error, as LangChain rethrows it. */
    function rateLimited(headers: Record<string, string> = {}): Error {
      return Object.assign(new Error('429 Rate limit reached'), {
        status: 429,
        headers: new Headers(headers),
      });
    }

    afterEach(() => {
      configService.get.mockReturnValue(undefined);
    });

    it('pauses the agent until the hinted time, instead of failing it', async () => {
      mockToolGraphOnce(
        makeStubGraph([], rateLimited({ 'retry-after': '120' })),
      );
      const { agent } = await seedAgentAndRole();
      const before = Date.now();

      await service.run(agent.id, undefined, new AbortController());

      const updated = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(updated.status).toBe(AgentStatus.Paused);
      expect(updated.pauseReason).toBe('rate_limited');
      expect(updated.pausedAt).toBeTruthy();
      expect(updated.rateLimitRetries).toBe(1);
      const wait = new Date(updated.resumeAfter ?? 0).getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(119_000);
      expect(wait).toBeLessThanOrEqual(121_000);
      expect(notifyFailed).not.toHaveBeenCalled();
      expect(auditRecord).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        agent.id,
        AuditEventType.StateChange,
        expect.objectContaining({ reason: 'rate_limited' }),
      );
    });

    it('doubles the wait for each rate limit in a row with no progress', async () => {
      mockToolGraphOnce(makeStubGraph([], rateLimited()));
      const { agent } = await seedAgentAndRole();
      await agentRepo.update(agent.id, { rateLimitRetries: 2 });
      const before = Date.now();

      await service.run(agent.id, 'Continue.', new AbortController());

      const updated = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(updated.rateLimitRetries).toBe(3);
      // Third in a row: 1 minute (the default) doubled twice.
      const wait = new Date(updated.resumeAfter ?? 0).getTime() - before;
      expect(wait).toBeGreaterThanOrEqual(240_000 - 1_000);
      expect(wait).toBeLessThanOrEqual(240_000 + 1_000);
    });

    it('leaves the agent for an explicit resume when auto-resume is off', async () => {
      configService.get.mockImplementation((key: string) =>
        key === 'RATE_LIMIT_AUTO_RESUME' ? 'false' : undefined,
      );
      mockToolGraphOnce(
        makeStubGraph([], rateLimited({ 'retry-after': '120' })),
      );
      const { agent } = await seedAgentAndRole();

      await service.run(agent.id, undefined, new AbortController());

      const updated = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(updated.pauseReason).toBe('rate_limited');
      expect(updated.resumeAfter).toBeNull();
    });
  });

  it('reports a human-readable reason when the run was aborted by the wall-clock timeout', async () => {
    // Simulates what LangGraph throws once the signal is aborted — the stub
    // graph itself doesn't consult the signal, so the abort is set directly.
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest
            .fn()
            .mockReturnValue(
              makeStubGraph([], new Error('The operation was aborted')),
            ),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();
    const abortController = new AbortController();
    abortController.abort('timeout');

    await service.run(agent.id, undefined, abortController);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      expect.stringMatching(/^timed out after \d+ seconds$/),
    );
  });

  it('falls back to a generic reason when the run throws an error with no message', async () => {
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest.fn().mockReturnValue(makeStubGraph([], new Error(''))),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();
    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      'unexpected LLM failure',
    );
  });

  it('retries and uses the retried response when the first turn produces empty content', async () => {
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest
            .fn()
            .mockReturnValue(
              makeSequentialStubGraph(BLANK_CONTENT_EVENTS, SUCCESS_EVENTS),
            ),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();
    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
    expect(notifyComplete).toHaveBeenCalledWith(
      agent.id,
      'Here is my analysis.',
    );
  });

  it('fails the run when content is still empty after the retry', async () => {
    jest.mocked(StateGraph).mockImplementationOnce(
      () =>
        ({
          addNode: jest.fn().mockReturnThis(),
          addEdge: jest.fn().mockReturnThis(),
          compile: jest
            .fn()
            .mockReturnValue(
              makeSequentialStubGraph(
                BLANK_CONTENT_EVENTS,
                BLANK_CONTENT_EVENTS,
              ),
            ),
        }) as unknown as InstanceType<typeof StateGraph>,
    );

    const { agent } = await seedAgentAndRole();
    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
    expect(notifyComplete).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      'LLM produced no output after retry',
    );
  });

  it('does nothing when the agent id does not exist', async () => {
    await expect(
      service.run(randomUUID(), undefined, new AbortController()),
    ).resolves.not.toThrow();
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
    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Completed);
  });

  it('aborts with a human-readable reason when more LLM calls are made than the configured maxIterations', async () => {
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

    // Decoupled from DEFAULT_AGENT_ITERATIONS — an explicit role-level
    // ceiling below the 11 calls the stub graph makes.
    const { agent, role } = await seedAgentAndRole();
    await roleRepo.update(role.id, { runConfig: { maxIterations: 10 } });

    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);

    // The terminal failed state_change (with its reason) is recorded by the
    // server via notifyFailed, not locally.
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      'exceeded 10 iterations',
    );
  });

  describe('required tool call enforcement', () => {
    const INTERACTIONS_TOOL = {
      serverName: 'tasks',
      tool: { name: 'tasks__complete_assignment' },
    };

    // Event set where the agent invoked complete_assignment but the call did not
    // flip the status (e.g. the tool errored). No on_tool_end, so no status
    // re-read fires mid-stream.
    const TOOL_FIRED_EVENTS = [
      {
        event: 'on_tool_start',
        name: 'tasks__complete_assignment',
        run_id: 'run-1',
        data: { input: {} },
      },
      ...SUCCESS_EVENTS,
    ];

    it('reminds the agent and takes the completed path when complete_assignment fires after the nudge', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const graph = makeSequentialStubGraph(SUCCESS_EVENTS, SUCCESS_EVENTS);
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        // Post-stream re-read: still running — enforcement kicks in
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        // Re-read after the nudge round: complete_assignment flipped the status
        .mockResolvedValueOnce({
          ...agent,
          status: AgentStatus.Completed,
          output: 'The real answer.',
        });

      await service.run(agent.id, undefined, new AbortController());

      expect(graph.streamEvents).toHaveBeenCalledTimes(2);
      const [nudgeInput] = graph.streamEvents.mock.calls[1] as [
        { messages: HumanMessage[] },
      ];
      expect(nudgeInput.messages[0].content).toBe(
        renderTemplate(agentPrompts.required_tools_reminder, {
          tools: 'tasks__complete_assignment',
        }),
      );
      // Completed via the tool path — no fallback write, no failure
      expect(notifyComplete).not.toHaveBeenCalled();
      expect(notifyFailed).not.toHaveBeenCalled();
      expect(auditRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        agent.id,
        AuditEventType.AgentLoopCompletion,
        expect.any(Object),
      );
    });

    // The main run and the reminder round share one terminal-status ladder;
    // cancellation is the arm a second copy would most easily have missed.
    it('stops cleanly when the task is cancelled during a required-tool reminder', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const graph = makeSequentialStubGraph(SUCCESS_EVENTS, SUCCESS_EVENTS);
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        // Post-stream re-read: still running — enforcement kicks in
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        // Re-read after the nudge round: the task was cancelled meanwhile
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Cancelled });

      await service.run(agent.id, undefined, new AbortController());

      // Cancellation already recorded its own state change server-side, so the
      // loop must neither fail the run nor write a completion summary.
      expect(notifyFailed).not.toHaveBeenCalled();
      expect(notifyComplete).not.toHaveBeenCalled();
      expect(auditRecord).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        agent.id,
        AuditEventType.AgentLoopCompletion,
        expect.any(Object),
      );
    });

    it('quotes a described tool_call block when the model wrote one out as text instead of invoking it', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const DESCRIBED_CALL_EVENTS = [
        {
          event: 'on_chat_model_start',
          name: 'ChatOpenAI',
          data: { input: { messages: [] } },
        },
        {
          event: 'on_chat_model_end',
          name: 'agent',
          data: {
            output: new AIMessage(
              'Calling it now:\n<tool_call>{"name":"complete_assignment"}</tool_call>',
            ),
          },
        },
      ];
      const graph = makeSequentialStubGraph(
        DESCRIBED_CALL_EVENTS,
        SUCCESS_EVENTS,
      );
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        .mockResolvedValueOnce({
          ...agent,
          status: AgentStatus.Completed,
          output: 'The real answer.',
        });

      await service.run(agent.id, undefined, new AbortController());

      const [nudgeInput] = graph.streamEvents.mock.calls[1] as [
        { messages: HumanMessage[] },
      ];
      expect(nudgeInput.messages[0].content).toBe(
        renderTemplate(
          agentPrompts.required_tools_reminder_with_described_call,
          {
            tools: 'tasks__complete_assignment',
            describedCall: '{"name":"complete_assignment"}',
          },
        ),
      );
    });

    it('uses the call-failed reminder when the tool fired but the run never completed', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const graph = makeSequentialStubGraph(TOOL_FIRED_EVENTS, SUCCESS_EVENTS);
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        .mockResolvedValueOnce({
          ...agent,
          status: AgentStatus.Completed,
          output: 'Recovered.',
        });

      await service.run(agent.id, undefined, new AbortController());

      const [nudgeInput] = graph.streamEvents.mock.calls[1] as [
        { messages: HumanMessage[] },
      ];
      expect(nudgeInput.messages[0].content).toBe(
        renderTemplate(agentPrompts.required_tools_call_failed, {
          tools: 'tasks__complete_assignment',
        }),
      );
    });

    it('fails the run and notifies tcp-server after exhausting the reminders', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const graph = makeSequentialStubGraph(
        SUCCESS_EVENTS,
        SUCCESS_EVENTS,
        SUCCESS_EVENTS,
      );
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        // Post-stream, two post-nudge re-reads, and failRun's completed-guard
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running });

      await service.run(agent.id, undefined, new AbortController());

      // Initial stream + 2 reminder rounds (DEFAULT_REQUIRED_TOOL_RETRIES)
      expect(graph.streamEvents).toHaveBeenCalledTimes(3);
      expect(notifyFailed).toHaveBeenCalledWith(
        agent.id,
        expect.stringContaining('complete_assignment'),
      );
      expect(notifyComplete).not.toHaveBeenCalled();
      const updated = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(updated.status).toBe(AgentStatus.Failed);
    });

    it('keeps the narrated-text fallback when requiredToolCalls is an empty array', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const graph = makeSequentialStubGraph(SUCCESS_EVENTS);
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      await agentRepo.update(agent.id, { requiredToolCalls: [] });

      await service.run(agent.id, undefined, new AbortController());

      expect(graph.streamEvents).toHaveBeenCalledTimes(1);
      expect(notifyComplete).toHaveBeenCalledWith(
        agent.id,
        'Here is my analysis.',
      );
      const updated = await agentRepo.findOneByOrFail({ id: agent.id });
      expect(updated.status).toBe(AgentStatus.Completed);
    });
  });

  describe('post-completion summary generation', () => {
    // No LLM call: generateAndRecordCompletionSummary (recordCompletionSummary
    // since Phase 4) builds the summary deterministically from tracked
    // actions/storage — cutting a redundant round-trip on every completed run.

    it('records a deterministic AgentLoopCompletion summary with placeholders when no actions/storage were tracked', async () => {
      const { agent, role, company } = await seedAgentAndRole();

      // runLoop() re-reads agent status after the stream to detect a tool-set
      // status change (e.g. complete_assignment); the initial run() lookup hits the
      // real DB and eager-loads role/company normally.
      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Completed });

      await service.run(agent.id, undefined, new AbortController());

      expect(auditRecord).toHaveBeenCalledWith(
        company.id,
        role.name,
        agent.id,
        AuditEventType.AgentLoopCompletion,
        expect.objectContaining({
          summary:
            'Task completed.\n\n' +
            'Actions taken (in order):\n(none recorded)\n\n' +
            'Storage changes:\n' +
            '- Created: (none)\n' +
            '- Modified: (none)\n' +
            '- Deleted: (none)\n' +
            '- Moved: (none)',
        }),
      );
      // No LLM call is made for the summary — buildChatModel's model is only
      // ever invoked for the agent turn itself, not a separate summary call.
      expect(factory.buildChatModel).toHaveBeenCalledTimes(1);
    });

    it('lists each tracked action and storage change in order', async () => {
      const toolEvents = [
        {
          event: 'on_tool_start',
          name: 'storage__append_working_file',
          run_id: 'run-1',
          data: { input: { filename: 'notes.md', content: 'hi' } },
        },
        {
          event: 'on_tool_end',
          name: 'storage__append_working_file',
          run_id: 'run-1',
          data: { output: 'Created working file: notes.md' },
        },
        ...SUCCESS_EVENTS,
      ];
      jest.mocked(StateGraph).mockImplementationOnce(
        () =>
          ({
            addNode: jest.fn().mockReturnThis(),
            addEdge: jest.fn().mockReturnThis(),
            addConditionalEdges: jest.fn().mockReturnThis(),
            compile: jest.fn().mockReturnValue(makeStubGraph(toolEvents)),
          }) as unknown as InstanceType<typeof StateGraph>,
      );

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Completed });

      await service.run(agent.id, undefined, new AbortController());

      const [, , , , payload] = auditRecord.mock.calls.find(
        ([, , , type]: [unknown, unknown, unknown, AuditEventType]) =>
          type === AuditEventType.AgentLoopCompletion,
      ) as [unknown, unknown, unknown, unknown, { summary: string }];
      expect(payload.summary).toContain('Actions taken (in order):\n1.');
    });
  });

  describe('initial prompt structure', () => {
    it('opens with a SystemMessage and closes with final_instruction as the last HumanMessage', async () => {
      let capturedInput: typeof MessagesAnnotation.State | undefined;

      jest.mocked(StateGraph).mockImplementationOnce(
        () =>
          ({
            addNode: jest.fn().mockReturnThis(),
            addEdge: jest.fn().mockReturnThis(),
            compile: jest.fn().mockReturnValue({
              streamEvents: jest
                .fn()
                .mockImplementation(
                  (input: typeof MessagesAnnotation.State) => {
                    capturedInput = input;
                    return {
                      // eslint-disable-next-line @typescript-eslint/require-await
                      [Symbol.asyncIterator]: async function* () {
                        for (const ev of SUCCESS_EVENTS) yield ev;
                      },
                    };
                  },
                ),
            }),
          }) as unknown as InstanceType<typeof StateGraph>,
      );

      const { agent } = await seedAgentAndRole();
      await service.run(agent.id, undefined, new AbortController());

      const messages = capturedInput!.messages;
      expect(messages[0]).toBeInstanceOf(SystemMessage);

      const last = messages[messages.length - 1];
      expect(last).toBeInstanceOf(HumanMessage);
      expect((last as HumanMessage).content).toBe(
        agentPrompts.final_instruction,
      );
    });

    it('presents the assignment as the mode prompt followed by the task prompt', async () => {
      let capturedInput: typeof MessagesAnnotation.State | undefined;

      jest.mocked(StateGraph).mockImplementationOnce(
        () =>
          ({
            addNode: jest.fn().mockReturnThis(),
            addEdge: jest.fn().mockReturnThis(),
            compile: jest.fn().mockReturnValue({
              streamEvents: jest
                .fn()
                .mockImplementation(
                  (input: typeof MessagesAnnotation.State) => {
                    capturedInput = input;
                    return {
                      // eslint-disable-next-line @typescript-eslint/require-await
                      [Symbol.asyncIterator]: async function* () {
                        for (const ev of SUCCESS_EVENTS) yield ev;
                      },
                    };
                  },
                ),
            }),
          }) as unknown as InstanceType<typeof StateGraph>,
      );

      const { agent } = await seedAgentAndRole();
      await service.run(agent.id, undefined, new AbortController());

      const messages = capturedInput!.messages;
      // Prompt part 4 now carries the implement-mode prompt plus the task prompt.
      const assignmentMsg = messages.find(
        (m) =>
          m instanceof HumanMessage &&
          typeof m.content === 'string' &&
          m.content.includes('Summarise the market.'),
      );
      expect(assignmentMsg).toBeDefined();
      expect((assignmentMsg as HumanMessage).content).toContain(
        MODE_PROMPTS.implement,
      );
    });

    it('uses the assignment mode prompt for a non-implement mode', async () => {
      let capturedInput: typeof MessagesAnnotation.State | undefined;

      jest.mocked(StateGraph).mockImplementationOnce(
        () =>
          ({
            addNode: jest.fn().mockReturnThis(),
            addEdge: jest.fn().mockReturnThis(),
            compile: jest.fn().mockReturnValue({
              streamEvents: jest
                .fn()
                .mockImplementation(
                  (input: typeof MessagesAnnotation.State) => {
                    capturedInput = input;
                    return {
                      // eslint-disable-next-line @typescript-eslint/require-await
                      [Symbol.asyncIterator]: async function* () {
                        for (const ev of SUCCESS_EVENTS) yield ev;
                      },
                    };
                  },
                ),
            }),
          }) as unknown as InstanceType<typeof StateGraph>,
      );

      const { agent } = await seedAgentAndRole({
        llmConfig: { provider: 'lm-studio', model: 'qwen3-5b', apiKey: 'k' },
        mode: 'plan',
      });
      await service.run(agent.id, undefined, new AbortController());

      const hasPlanPrompt = capturedInput!.messages.some(
        (m) =>
          m instanceof HumanMessage &&
          typeof m.content === 'string' &&
          m.content.includes(MODE_PROMPTS.plan),
      );
      expect(hasPlanPrompt).toBe(true);
    });

    it('resolves an assignment-completed-path material against a prior plan step, instead of failing the run', async () => {
      let capturedInput: typeof MessagesAnnotation.State | undefined;

      jest.mocked(StateGraph).mockImplementationOnce(
        () =>
          ({
            addNode: jest.fn().mockReturnThis(),
            addEdge: jest.fn().mockReturnThis(),
            compile: jest.fn().mockReturnValue({
              streamEvents: jest
                .fn()
                .mockImplementation(
                  (input: typeof MessagesAnnotation.State) => {
                    capturedInput = input;
                    return {
                      // eslint-disable-next-line @typescript-eslint/require-await
                      [Symbol.asyncIterator]: async function* () {
                        for (const ev of SUCCESS_EVENTS) yield ev;
                      },
                    };
                  },
                ),
            }),
          }) as unknown as InstanceType<typeof StateGraph>,
      );

      const company = await companyRepo.save(
        companyRepo.create({ slug: 'acme', name: 'ACME', description: 'x' }),
      );
      const role = await roleRepo.save(
        roleRepo.create({
          companyId: company.id,
          slug: 'analyst',
          name: 'analyst',
          description: 'Analyses.',
          llmConfig: {
            provider: 'lm-studio',
            model: 'qwen3-5b',
            apiKey: 'test-key',
          },
        }),
      );
      const task = await taskRepo.save(
        taskRepo.create({
          companyId: company.id,
          request: 'do it',
          shortcode: '000',
        }),
      );
      // A prior plan step that already approved 'draft.md'.
      await assignmentRepo.save(
        assignmentRepo.create({
          taskId: task.id,
          companyId: company.id,
          roleId: role.id,
          mode: 'implement',
          orderIndex: 0,
          prompt: 'write the draft',
          status: 'succeeded',
          expected: [{ type: 'assignment-working-path', value: 'draft.md' }],
          approved: [{ type: 'assignment-completed-path', value: 'draft.md' }],
        }),
      );
      const assignment = await assignmentRepo.save(
        assignmentRepo.create({
          taskId: task.id,
          companyId: company.id,
          roleId: role.id,
          mode: 'implement',
          orderIndex: 1,
          prompt: 'revise the draft',
          status: 'in-progress',
          materials: [{ type: 'assignment-completed-path', value: 'draft.md' }],
          expected: [],
        }),
      );
      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: company.id,
          roleId: role.id,
          assignmentId: assignment.id,
          initialPrompt: 'revise the draft',
        }),
      );
      await assignmentRepo.update(assignment.id, { agentId: agent.id });

      await service.run(agent.id, undefined, new AbortController());

      const assignmentMsg = capturedInput!.messages.find(
        (m) =>
          m instanceof HumanMessage &&
          typeof m.content === 'string' &&
          m.content.includes('revise the draft'),
      );
      expect(assignmentMsg).toBeDefined();
      // The material resolves without crashing prompt assembly (the bug this
      // test guards against) and renders as the bare filename — never the
      // resolved storage key, which would leak the wrong string back to the
      // scoped storage tools.
      expect((assignmentMsg as HumanMessage).content).toContain('- draft.md');
      expect((assignmentMsg as HumanMessage).content).not.toContain(
        'assignments/0/completed/draft.md',
      );
    });

    it('substitutes companyId and roleId into the rendered system prompt', async () => {
      let capturedInput: typeof MessagesAnnotation.State | undefined;

      jest.mocked(StateGraph).mockImplementationOnce(
        () =>
          ({
            addNode: jest.fn().mockReturnThis(),
            addEdge: jest.fn().mockReturnThis(),
            compile: jest.fn().mockReturnValue({
              streamEvents: jest
                .fn()
                .mockImplementation(
                  (input: typeof MessagesAnnotation.State) => {
                    capturedInput = input;
                    return {
                      // eslint-disable-next-line @typescript-eslint/require-await
                      [Symbol.asyncIterator]: async function* () {
                        for (const ev of SUCCESS_EVENTS) yield ev;
                      },
                    };
                  },
                ),
            }),
          }) as unknown as InstanceType<typeof StateGraph>,
      );

      const { agent, role, company } = await seedAgentAndRole({
        llmConfig: {
          provider: 'lm-studio',
          model: 'qwen3-5b',
          apiKey: 'test-key',
        },
        systemPromptTemplate: 'Company: {{companyId}}, Role: {{roleId}}',
      });
      await service.run(agent.id, undefined, new AbortController());

      const systemMessage = capturedInput!.messages[0];
      expect(systemMessage).toBeInstanceOf(SystemMessage);
      expect((systemMessage as SystemMessage).content).toBe(
        `Company: ${company.id}, Role: ${role.id}`,
      );
    });
  });
});
