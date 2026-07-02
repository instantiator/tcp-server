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
  LcpAgent,
  LcpCompany,
  LcpRole,
  LlmConfig,
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
import { AgentRegistryService } from '../registry/agent-registry.service';
import { StorageTrackingClientService } from '../storage-tracking/storage-tracking-client.service';
import { agentPrompts } from '../agent-prompts';
import { AgentLoopService } from './agent-loop.service';

const ALL_ENTITIES = [LcpCompany, LcpRole, LcpAgent];

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
  return { streamEvents };
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
  let registry: AgentRegistryService;
  let agentRepo: Repository<LcpAgent>;
  let roleRepo: Repository<LcpRole>;
  let companyRepo: Repository<LcpCompany>;
  let auditRecord: jest.Mock;
  let notifyComplete: jest.Mock;
  let notifyFailed: jest.Mock;
  let mcpClient: { loadTools: jest.Mock };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest
      .spyOn(factory, 'buildChatModel')
      .mockReturnValue({} as ReturnType<typeof factory.buildChatModel>);

    auditRecord = jest.fn();
    notifyComplete = jest.fn();
    notifyFailed = jest.fn();

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
          provide: AuditClientService,
          useValue: { record: auditRecord, notifyComplete, notifyFailed },
        },
        {
          provide: StorageTrackingClientService,
          useValue: { patch: jest.fn() },
        },
        {
          provide: AgentRagService,
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
    registry = testingModule.get(AgentRegistryService);
    agentRepo = testingModule.get(getRepositoryToken(LcpAgent));
    roleRepo = testingModule.get(getRepositoryToken(LcpRole));
    companyRepo = testingModule.get(getRepositoryToken(LcpCompany));
    mcpClient = testingModule.get(McpClientService);
  });

  afterEach(async () => {
    auditRecord.mockClear();
    notifyComplete.mockClear();
    notifyFailed.mockClear();
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
      systemPromptTemplate?: string;
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
        llmDefault: opts.companyLlmDefault,
      }),
    );
    const role = await roleRepo.save(
      roleRepo.create({
        companyId: company.id,
        name: 'analyst',
        description: 'Analyses.',
        llmConfig: opts.llmConfig,
        systemPromptTemplate:
          opts.systemPromptTemplate ?? 'You are {{name}} as of {{date}}.',
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

  it('passes the real agentId/companyId as MCP tool context, not LLM-suppliable values', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id);

    expect(mcpClient.loadTools).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      { agentId: agent.id, companyId: agent.companyId },
    );
  });

  it('writes an audit event for the LLM response', async () => {
    const { agent } = await seedAgentAndRole();

    await service.run(agent.id);

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

    await service.run(agent.id);

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

  it('uses company llmDefault when role has no llmConfig', async () => {
    const { agent } = await seedAgentAndRole({
      llmConfig: undefined,
      companyLlmDefault: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        apiKey: 'test-key',
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
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      expect.stringContaining('No LLM config'),
    );
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
    await service.run(agent.id);

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
    await service.run(agent.id);

    const updated = await agentRepo.findOneByOrFail({ id: agent.id });
    expect(updated.status).toBe(AgentStatus.Failed);
    expect(notifyComplete).not.toHaveBeenCalled();
    expect(notifyFailed).toHaveBeenCalledWith(
      agent.id,
      'LLM produced no output after retry',
    );
  });

  it('does nothing when the agent id does not exist', async () => {
    await expect(service.run(randomUUID())).resolves.not.toThrow();
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
      serverName: 'interactions',
      tool: { name: 'interactions__complete_task' },
    };

    // Event set where the agent invoked complete_task but the call did not
    // flip the status (e.g. the tool errored). No on_tool_end, so no status
    // re-read fires mid-stream.
    const TOOL_FIRED_EVENTS = [
      {
        event: 'on_tool_start',
        name: 'interactions__complete_task',
        run_id: 'run-1',
        data: { input: {} },
      },
      ...SUCCESS_EVENTS,
    ];

    // Installs a StateGraph mock exposing the full builder chain used when
    // tools are present (addConditionalEdges is only called for tool graphs).
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

    it('reminds the agent and takes the completed path when complete_task fires after the nudge', async () => {
      mcpClient.loadTools.mockResolvedValueOnce([INTERACTIONS_TOOL]);
      const graph = makeSequentialStubGraph(SUCCESS_EVENTS, SUCCESS_EVENTS);
      mockToolGraphOnce(graph);

      const { agent } = await seedAgentAndRole();
      jest
        .spyOn(agentRepo, 'findOneBy')
        // Post-stream re-read: still running — enforcement kicks in
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Running })
        // Re-read after the nudge round: complete_task flipped the status
        .mockResolvedValueOnce({
          ...agent,
          status: AgentStatus.Completed,
          output: 'The real answer.',
        });

      await service.run(agent.id);

      expect(graph.streamEvents).toHaveBeenCalledTimes(2);
      const [nudgeInput] = graph.streamEvents.mock.calls[1] as [
        { messages: HumanMessage[] },
      ];
      expect(nudgeInput.messages[0].content).toBe(
        renderTemplate(agentPrompts.required_tools_reminder, {
          tools: 'interactions__complete_task',
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

      await service.run(agent.id);

      const [nudgeInput] = graph.streamEvents.mock.calls[1] as [
        { messages: HumanMessage[] },
      ];
      expect(nudgeInput.messages[0].content).toBe(
        renderTemplate(agentPrompts.required_tools_call_failed, {
          tools: 'interactions__complete_task',
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

      await service.run(agent.id);

      // Initial stream + 2 reminder rounds (DEFAULT_REQUIRED_TOOL_RETRIES)
      expect(graph.streamEvents).toHaveBeenCalledTimes(3);
      expect(notifyFailed).toHaveBeenCalledWith(
        agent.id,
        expect.stringContaining('complete_task'),
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

      await service.run(agent.id);

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
    it('records an AgentLoopCompletion audit event when the agent completes via complete_task', async () => {
      const mockInvoke = jest
        .fn()
        .mockResolvedValue(
          new AIMessage('{"summary": "The agent analysed the market."}'),
        );
      jest.spyOn(factory, 'buildChatModel').mockReturnValue({
        invoke: mockInvoke,
      } as unknown as ReturnType<typeof factory.buildChatModel>);

      const { agent, role, company } = await seedAgentAndRole();

      // runLoop() re-reads agent status after the stream to detect a tool-set
      // status change (e.g. complete_task); the initial run() lookup hits the
      // real DB and eager-loads role/company normally.
      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Completed });

      await service.run(agent.id);

      expect(auditRecord).toHaveBeenCalledWith(
        company.id,
        role.name,
        agent.id,
        AuditEventType.AgentLoopCompletion,
        expect.objectContaining({ summary: 'The agent analysed the market.' }),
      );
    });

    it('records a structured fallback summary when LLM summary generation fails', async () => {
      jest.spyOn(factory, 'buildChatModel').mockReturnValue({
        invoke: jest.fn().mockRejectedValue(new Error('LLM timeout')),
      } as unknown as ReturnType<typeof factory.buildChatModel>);

      const { agent } = await seedAgentAndRole();

      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Completed });

      await expect(service.run(agent.id)).resolves.not.toThrow();

      // Fallback summary is always recorded even when the LLM call fails
      expect(auditRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        agent.id,
        AuditEventType.AgentLoopCompletion,
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          summary: expect.stringMatching(
            /Completed task:.*no actions recorded/,
          ),
        }),
      );
    });

    it('strips markdown fences from the LLM summary response', async () => {
      jest.spyOn(factory, 'buildChatModel').mockReturnValue({
        invoke: jest
          .fn()
          .mockResolvedValue(
            new AIMessage('```json\n{"summary": "Clean summary."}\n```'),
          ),
      } as unknown as ReturnType<typeof factory.buildChatModel>);

      const { agent } = await seedAgentAndRole();

      jest
        .spyOn(agentRepo, 'findOneBy')
        .mockResolvedValueOnce({ ...agent, status: AgentStatus.Completed });

      await service.run(agent.id);

      expect(auditRecord).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        agent.id,
        AuditEventType.AgentLoopCompletion,
        expect.objectContaining({ summary: 'Clean summary.' }),
      );
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
      await service.run(agent.id);

      const messages = capturedInput!.messages;
      expect(messages[0]).toBeInstanceOf(SystemMessage);

      const last = messages[messages.length - 1];
      expect(last).toBeInstanceOf(HumanMessage);
      expect((last as HumanMessage).content).toBe(
        agentPrompts.final_instruction,
      );
    });

    it('includes the task initialPrompt as a HumanMessage', async () => {
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
      await service.run(agent.id);

      const messages = capturedInput!.messages;
      const hasTaskPrompt = messages.some(
        (m) =>
          m instanceof HumanMessage && m.content === 'Summarise the market.',
      );
      expect(hasTaskPrompt).toBe(true);
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
      await service.run(agent.id);

      const systemMessage = capturedInput!.messages[0];
      expect(systemMessage).toBeInstanceOf(SystemMessage);
      expect((systemMessage as SystemMessage).content).toBe(
        `Company: ${company.id}, Role: ${role.id}`,
      );
    });
  });
});
