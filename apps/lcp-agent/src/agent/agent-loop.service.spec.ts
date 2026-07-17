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
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  LlmConfig,
  MODE_PROMPTS,
  renderTemplate,
} from '@lcp/shared';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import * as factory from '../llm/llm-factory';
import { McpClientService } from '../mcp/mcp-client.service';
import { AgentRagService } from '../rag/agent-rag.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { agentPrompts } from '../agent-prompts';
import { AgentEventPublisherService } from './agent-event-publisher.service';
import { AgentLoopService } from './agent-loop.service';

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent, LcpTask, LcpAssignment];

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
  let agentRepo: Repository<LcpAgent>;
  let assignmentRepo: Repository<LcpAssignment>;
  let roleRepo: Repository<LcpRole>;
  let companyRepo: Repository<LcpCompany>;
  let auditRecord: jest.Mock;
  let notifyComplete: jest.Mock;
  let notifyFailed: jest.Mock;
  let publishEvent: jest.Mock;
  let mcpClient: { loadTools: jest.Mock };
  let ragProvider: { hasKnowledge: jest.Mock; retrieve: jest.Mock };
  let configService: { get: jest.Mock; getOrThrow: jest.Mock };
  let prepareContext: jest.Mock;
  let checkBudget: jest.Mock;

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
          useValue: {
            retrieve: jest.fn().mockResolvedValue([]),
            hasKnowledge: jest.fn().mockResolvedValue(true),
          },
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
    agentRepo = testingModule.get(getRepositoryToken(LcpAgent));
    assignmentRepo = testingModule.get(getRepositoryToken(LcpAssignment));
    roleRepo = testingModule.get(getRepositoryToken(LcpRole));
    companyRepo = testingModule.get(getRepositoryToken(LcpCompany));
    mcpClient = testingModule.get(McpClientService);
    ragProvider = testingModule.get(AgentRagService);
    configService = testingModule.get(ConfigService);
  });

  afterEach(async () => {
    auditRecord.mockClear();
    notifyComplete.mockClear();
    notifyFailed.mockClear();
    publishEvent.mockClear();
    prepareContext.mockClear();
    checkBudget.mockClear();
    // Agents before assignments (agent.assignmentId FK).
    await agentRepo.clear();
    await assignmentRepo.clear();
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
      mode?: LcpAssignment['mode'];
      materials?: LcpAssignment['materials'];
      expected?: LcpAssignment['expected'];
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

  it('publishes agent_status and llm observability events during a successful run', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id, undefined, new AbortController());

    const kinds = publishEvent.mock.calls.map(
      ([, event]: [string, { kind: string }]) => event.kind,
    );
    // Running transition (from updateStatus) and the LLM request lifecycle
    // (from the stream mapper) both reach observing clients.
    expect(kinds).toContain('agent_status');
    expect(kinds).toContain('llm');
    expect(publishEvent).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({
        kind: 'agent_status',
        data: { status: AgentStatus.Running },
      }),
    );
    expect(publishEvent).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({
        kind: 'agent_status',
        data: { status: AgentStatus.Completed },
      }),
    );
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
      expect(ragProvider.retrieve).not.toHaveBeenCalled();
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
    await service.run(agent.id, undefined, new AbortController());

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);

    expect(auditRecord).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      agent.id,
      AuditEventType.StateChange,
      expect.objectContaining({ reason: 'max_iterations' }),
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

    it('fails the run and notifies lcp-server after exhausting the reminders', async () => {
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
