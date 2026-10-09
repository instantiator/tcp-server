import { NotFoundException } from '@nestjs/common';
import { randomUUID, UUID } from 'crypto';
import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  KnowledgeRetrievalService,
  TcpAgent,
  TcpRole,
  MODE_PROMPTS,
  WireEvent,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';
import { AuditEventPublisher } from '../events/audit-event-publisher.service';
import { CompanyEventService } from '../events/company-event.service';
import { TaskEventService } from '../events/task-event.service';

// Mock heavy LangGraph + LLM deps before importing ChatService
jest.mock('@langchain/langgraph', () => ({
  StateGraph: jest.fn().mockReturnValue({
    addNode: jest.fn().mockReturnThis(),
    addEdge: jest.fn().mockReturnThis(),
    addConditionalEdges: jest.fn().mockReturnThis(),
    compile: jest.fn().mockReturnValue({
      streamEvents: jest.fn(),
      invoke: jest.fn(),
      getState: jest.fn(),
      updateState: jest.fn(),
    }),
  }),
  MessagesAnnotation: { State: {} },
  END: 'END',
}));

jest.mock('@langchain/langgraph/prebuilt', () => ({
  ToolNode: jest.fn(),
  toolsCondition: jest.fn(),
}));

jest.mock('@langchain/langgraph-checkpoint-postgres', () => ({
  PostgresSaver: {
    fromConnString: jest.fn(),
  },
}));

jest.mock('@tcp/shared', () => {
  const actual =
    jest.requireActual<typeof import('@tcp/shared')>('@tcp/shared');
  return {
    ...actual,
    buildChatModel: jest.fn().mockReturnValue({
      invoke: jest.fn(),
      bindTools: jest.fn().mockReturnValue({ invoke: jest.fn() }),
    }),
    resolveMcpServerUrls: jest.fn().mockReturnValue({}),
  };
});

jest.mock('@langchain/core/utils/tiktoken', () => ({
  getEncoding: jest.fn().mockResolvedValue({
    encode: (text: string) => new Uint32Array(Math.ceil(text.length / 4)),
  }),
}));

jest.mock('@langchain/core/messages', () => {
  const actual = jest.requireActual<typeof import('@langchain/core/messages')>(
    '@langchain/core/messages',
  );
  return { ...actual, trimMessages: jest.fn().mockResolvedValue([]) };
});

import { ChatService } from './chat.service';
import { ChatTurnEnvironmentService } from './chat-turn-environment.service';
import { ChatTurnPromptService } from './chat-turn-prompt.service';
import { AIMessage } from '@langchain/core/messages';
import { StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { AgentEventService } from '../events/agent-event.service';

function makeAgent(overrides: Partial<TcpAgent> = {}): TcpAgent {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    roleId: randomUUID(),
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: '',
    assignmentId: randomUUID(),
    // A chat agent carries a chat-mode orphan assignment; runTurn renders it as
    // prompt part 4 (mode prompt + user message).
    assignment: {
      mode: 'chat',
      materials: [],
      expected: [],
      task: null,
      taskId: null,
      orderIndex: null,
      id: randomUUID(),
    } as never,
    output: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
    version: 1,
    rateLimitRetries: 0,
    ...overrides,
  };
}

function makeRole(overrides: Partial<TcpRole> = {}): TcpRole {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    slug: 'analyst',
    name: 'analyst',
    description: 'Analyses things.',
    llmConfig: { provider: 'lm-studio', model: 'qwen3-5b' },
    systemPromptTemplate: 'You are {{name}}.',
    knowledgeDomains: [],
    mcpServerList: [],
    queryIndex: 0,
    company: {} as never,
    ...overrides,
  };
}

/** Builds an async-iterable of LangGraph stream events (optionally throwing). */
function streamOf(
  events: Array<Record<string, unknown>>,
  throwErr?: Error,
): AsyncIterable<Record<string, unknown>> {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    [Symbol.asyncIterator]: async function* () {
      if (throwErr) throw throwErr;
      for (const e of events) yield e;
    },
  };
}

/** A stream that ends with the given text as the model's final message. */
function responseStream(text: string): AsyncIterable<Record<string, unknown>> {
  return streamOf([
    { event: 'on_chat_model_start', name: 'ChatOpenAI', data: {} },
    {
      event: 'on_chat_model_end',
      name: 'agent',
      data: { output: new AIMessage(text) },
    },
  ]);
}

const TERMINAL_STATUSES = ['completed', 'failed', 'idle', 'cancelled'];

/** True for a terminal agent `state_change` WireEvent (drives turn-end detection). */
function isTerminal(e: WireEvent): boolean {
  return (
    e.type === 'audit' &&
    e.event.eventType === AuditEventType.StateChange &&
    e.event.payload.entity === 'agent' &&
    TERMINAL_STATUSES.includes(String(e.event.payload.newStatus))
  );
}

/** True for a failed agent `state_change` WireEvent. */
function isFailed(e: WireEvent): boolean {
  return (
    e.type === 'audit' &&
    e.event.eventType === AuditEventType.StateChange &&
    e.event.payload.entity === 'agent' &&
    e.event.payload.newStatus === 'failed'
  );
}

/** Extracts the response text from the terminal `state_change`, if present. */
function completedResponse(events: WireEvent[]): string | undefined {
  const event = events.find(isTerminal);
  return event && event.type === 'audit'
    ? (event.event.payload.response as string | undefined)
    : undefined;
}

describe('ChatService', () => {
  let agentRepo: {
    findOne: jest.Mock;
    findOneBy: jest.Mock;
    update: jest.Mock;
  };
  let assignmentRepo: { createQueryBuilder: jest.Mock };
  let assignmentUpdateQueryBuilder: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };
  let roleRepo: { findOneBy: jest.Mock };
  let companyRepo: { findOneBy: jest.Mock };
  let auditService: { write: jest.Mock; record: jest.Mock };
  let config: ConfigService;
  let service: ChatService;
  let compiledGraph: {
    streamEvents: jest.Mock;
    invoke: jest.Mock;
    getState: jest.Mock;
    updateState: jest.Mock;
  };
  let mockCheckpointer: { setup: jest.Mock; end: jest.Mock };
  let contextManager: ContextManagerService;
  let agentEvents: AgentEventService;
  let ragRetrieval: { retrieve: jest.Mock };
  let mcpClient: { loadTools: jest.Mock };

  beforeEach(() => {
    // sendMessage loads the agent (with its assignment relation) via findOne;
    // runTurn's internal terminal-status/re-fetch checks use findOneBy. The two
    // are aliased so a test's `findOneBy.mockResolvedValue(agent)` drives both,
    // and call order (load first, then internal checks) preserves the Once
    // sequences used by the pause/complete-race tests.
    const findAgent = jest.fn();
    agentRepo = {
      findOne: findAgent,
      findOneBy: findAgent,
      update: jest.fn().mockResolvedValue(undefined),
    };
    assignmentUpdateQueryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    assignmentRepo = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValue(assignmentUpdateQueryBuilder),
    };
    roleRepo = { findOneBy: jest.fn() };
    companyRepo = { findOneBy: jest.fn() };
    auditService = {
      write: jest.fn().mockResolvedValue(undefined),
      record: jest.fn().mockResolvedValue(undefined),
    };
    config = {
      getOrThrow: jest.fn().mockReturnValue('postgres://test'),
      // Returns undefined for all LLM env vars by default (no env fallback active)
      get: jest.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    mockCheckpointer = {
      setup: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
    };
    (PostgresSaver.fromConnString as jest.Mock).mockReturnValue(
      mockCheckpointer,
    );

    compiledGraph = {
      streamEvents: jest.fn().mockReturnValue(responseStream('Response.')),
      invoke: jest.fn(),
      // next: [] simulates the graph reaching its natural end (no tool
      // call/interrupt) — the common case for these tests. Tests simulating
      // a mid-turn pause/complete override this to next: ['agent'].
      getState: jest
        .fn()
        .mockResolvedValue({ values: { messages: [] }, next: [] }),
      updateState: jest.fn().mockResolvedValue({}),
    };
    (StateGraph as jest.Mock).mockReturnValue({
      addNode: jest.fn().mockReturnThis(),
      addEdge: jest.fn().mockReturnThis(),
      compile: jest.fn().mockReturnValue(compiledGraph),
    });

    // Wire real context services (tiktoken is mocked above)
    const budget = new ContextBudgetService();
    const compactor = new ContextCompactorService(budget);
    const guard = new IncomingDataGuardService(budget, compactor);
    agentEvents = new AgentEventService(config);
    // Wire the audit mock through the real publisher so recorded rows reach the
    // observed agent stream, exactly as persist-then-publish does in production.
    const publisher = new AuditEventPublisher(
      agentEvents,
      { emit: jest.fn() } as unknown as TaskEventService,
      { emit: jest.fn() } as unknown as CompanyEventService,
    );
    auditService.record.mockImplementation(
      (
        companyId: string,
        role: string,
        agentId: string | null,
        eventType: AuditEventType,
        payload: Record<string, unknown>,
      ) => {
        publisher.publish({
          id: randomUUID(),
          timestamp: new Date(),
          companyId,
          role,
          agentId: agentId ?? null,
          assignmentId: null,
          taskId: null,
          eventType,
          payload,
        } as AuditEvent);
        return Promise.resolve();
      },
    );
    contextManager = new ContextManagerService(
      budget,
      compactor,
      guard,
      auditService,
    );

    ragRetrieval = { retrieve: jest.fn().mockResolvedValue([]) };
    mcpClient = { loadTools: jest.fn().mockResolvedValue([]) };

    service = new ChatService(
      config,
      contextManager,
      agentEvents,
      new ChatTurnEnvironmentService(
        config,
        contextManager,
        mcpClient as never,
      ),
      new ChatTurnPromptService(
        config,
        contextManager,
        ragRetrieval as unknown as KnowledgeRetrievalService,
      ),
      auditService as unknown as AuditService,
      agentRepo as never,
      assignmentRepo as never,
      roleRepo as never,
      companyRepo as never,
    );
  });

  afterEach(async () => {
    await agentEvents.onModuleDestroy();
  });

  /**
   * Subscribes to the agent's event stream, sends the message, and resolves
   * once a terminal (`completed`/`failed`) event arrives — mirroring how a
   * real SSE client observes the detached turn.
   */
  async function sendAndCollect(
    agentId: UUID,
    message: string,
  ): Promise<WireEvent[]> {
    const events: WireEvent[] = [];
    const done = new Promise<void>((resolve) => {
      const sub = agentEvents.observe(agentId).subscribe((event) => {
        events.push(event);
        if (isTerminal(event)) {
          sub.unsubscribe();
          resolve();
        }
      });
    });
    await service.sendMessage(agentId, message);
    await done;
    return events;
  }

  /** Reads the messages passed to the (mocked) graph stream for one turn. */
  function streamedMessages(): { content: string }[] {
    const call = compiledGraph.streamEvents.mock.calls[0] as [
      { messages: { content: string }[] },
    ];
    return call[0].messages;
  }

  it('throws NotFoundException when the agent does not exist', async () => {
    agentRepo.findOneBy.mockResolvedValue(null);
    await expect(service.sendMessage(randomUUID(), 'Hello')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when the role does not exist', async () => {
    agentRepo.findOneBy.mockResolvedValue(makeAgent());
    roleRepo.findOneBy.mockResolvedValue(null);
    await expect(service.sendMessage(randomUUID(), 'Hello')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws NotFoundException when no LLM config is available from any source', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ llmConfig: null });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue({ llmConfig: null });
    // config.get already returns undefined for all LLM vars (set in beforeEach)
    await expect(service.sendMessage(agent.id, 'Hello')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('uses env fallback LLM config when role and company have none', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ llmConfig: null });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue({ llmConfig: null });
    (config.get as jest.Mock).mockImplementation((key: string) => {
      if (key === 'LLM_PROVIDER') return 'lm-studio';
      if (key === 'LLM_MODEL') return 'qwen3-5b';
      if (key === 'LLM_BASE_URL') return 'http://localhost:1234/v1';
      return undefined;
    });
    compiledGraph.streamEvents.mockReturnValue(
      responseStream('Response via env fallback.'),
    );

    const events = await sendAndCollect(agent.id, 'Hello');
    expect(completedResponse(events)).toBe('Response via env fallback.');
  });

  it('substitutes companyId and roleId into the rendered system prompt', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({
      systemPromptTemplate: 'Company: {{companyId}}, Role: {{roleId}}',
    });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    await sendAndCollect(agent.id, 'Hello');

    expect(streamedMessages()[0].content).toBe(
      `Company: ${agent.companyId}, Role: ${role.id}`,
    );
  });

  it('sends the first message with system prompt prepended and emits the response as a completed event', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    compiledGraph.streamEvents.mockReturnValue(responseStream('Hi there!'));

    const events = await sendAndCollect(agent.id, 'Hello');

    expect(completedResponse(events)).toBe('Hi there!');
    // threadId should be set on first call
    expect(agentRepo.update).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ threadId: agent.id }),
    );
    // Output is persisted for the recovery/replay path
    expect(agentRepo.update).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({
        status: AgentStatus.Idle,
        output: 'Hi there!',
      }),
    );
    // Audit events: LlmRequest + LlmResponse
    expect(auditService.record).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      AuditEventType.LlmRequest,
      expect.any(Object),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      AuditEventType.LlmResponse,
      expect.any(Object),
    );
  });

  it('waits for a slow llm_response audit write before emitting the terminal event, so a client reading the stream in order never sees the terminal event first', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    compiledGraph.streamEvents.mockReturnValue(responseStream('Hi there!'));

    // Simulate the llm_response row's persist-then-publish taking a moment —
    // exactly the ordering gap that let a fire-and-forget write be overtaken
    // by the (awaited) terminal state_change record.
    type RecordArgs = [
      string,
      string,
      string | null,
      AuditEventType,
      Record<string, unknown>,
    ];
    const originalImpl = auditService.record.getMockImplementation() as (
      ...args: RecordArgs
    ) => Promise<void>;
    auditService.record.mockImplementation((...args: RecordArgs) => {
      const [, , , eventType] = args;
      if (eventType !== AuditEventType.LlmResponse) {
        return originalImpl(...args);
      }
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          void originalImpl(...args);
          resolve();
        }, 20),
      );
    });

    const events = await sendAndCollect(agent.id, 'Hello');

    const responseIndex = events.findIndex(
      (e) =>
        e.type === 'audit' && e.event.eventType === AuditEventType.LlmResponse,
    );
    const terminalIndex = events.findIndex(isTerminal);
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeLessThan(terminalIndex);
  });

  it('passes the real agentId/companyId as MCP tool context, not LLM-suppliable values', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);

    await sendAndCollect(agent.id, 'Hello');

    expect(mcpClient.loadTools).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      { agentId: agent.id, companyId: agent.companyId },
    );
  });

  it('does not prepend system prompt on subsequent messages', async () => {
    const agent = makeAgent({ threadId: randomUUID() });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    compiledGraph.streamEvents.mockReturnValue(responseStream('Got it.'));

    const events = await sendAndCollect(agent.id, 'Follow-up');
    expect(completedResponse(events)).toBe('Got it.');

    // threadId should NOT be set again
    expect(agentRepo.update).not.toHaveBeenCalledWith(
      agent.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ threadId: expect.any(String) }),
    );
  });

  it('sets agent status to Failed and emits a failed event on LLM error', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    compiledGraph.streamEvents.mockReturnValue(
      streamOf([], new Error('LLM down')),
    );

    const events = await sendAndCollect(agent.id, 'Hello');

    expect(events.some(isFailed)).toBe(true);
    expect(agentRepo.update).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ status: AgentStatus.Failed }),
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      AuditEventType.StateChange,
      expect.any(Object),
    );
    // sendAndCollect resolves on the terminal state_change, which is recorded
    // before the finally-block cleanup runs — let that microtask settle.
    await new Promise((r) => setImmediate(r));
    // PostgresSaver.end() must always be called to release the connection
    expect(mockCheckpointer.end).toHaveBeenCalled();
    // The chat-mode orphan assignment behind the agent gets the same
    // human-readable failureReason — it's never covered by
    // TaskOrchestrationService.handleAgentFailed (that only fires for
    // task-linked assignments), so ChatService must set it itself.
    expect(assignmentRepo.createQueryBuilder).toHaveBeenCalled();
    expect(assignmentUpdateQueryBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', failureReason: 'LLM down' }),
    );
  });

  // 002.02 stage 2: recordTurnFailure used to publish the failed state_change
  // before writing the agent row, so a client that refetched on the event
  // could still read the pre-failure status.
  it('publishes the failed state_change only after the agent row (and assignment) are written', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    compiledGraph.streamEvents.mockReturnValue(
      streamOf([], new Error('LLM down')),
    );

    await sendAndCollect(agent.id, 'Hello');
    // Let the finally-block cleanup (and any trailing microtasks) settle.
    await new Promise((r) => setImmediate(r));

    const updateCallIndex = (
      agentRepo.update.mock.calls as [string, { status?: string }][]
    ).findIndex(([, patch]) => patch.status === AgentStatus.Failed);
    expect(updateCallIndex).toBeGreaterThanOrEqual(0);

    const publishCallIndex = (
      auditService.record.mock.calls as [
        string,
        string,
        string | null,
        AuditEventType,
        { newStatus?: string },
      ][]
    ).findIndex(
      ([, , , eventType, payload]) =>
        eventType === AuditEventType.StateChange &&
        payload.newStatus === AgentStatus.Failed,
    );
    expect(publishCallIndex).toBeGreaterThanOrEqual(0);

    expect(
      agentRepo.update.mock.invocationCallOrder[updateCallIndex],
    ).toBeLessThan(
      auditService.record.mock.invocationCallOrder[publishCallIndex],
    );
  });

  it('returns early without a terminal event when a tool paused the agent mid-turn', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    // A pausing tool call interrupts the graph (next: ['agent']) instead of
    // reaching natural end — runSupervisedGraph checks terminal status there.
    compiledGraph.getState.mockResolvedValue({
      values: { messages: [] },
      next: ['agent'],
    });
    // Validation load returns Idle; the terminal-status check returns Paused.
    agentRepo.findOneBy
      .mockResolvedValueOnce(agent)
      .mockResolvedValue({ ...agent, status: AgentStatus.Paused });
    roleRepo.findOneBy.mockResolvedValue(role);

    const emitted: WireEvent[] = [];
    agentEvents.observe(agent.id).subscribe((e) => emitted.push(e));
    await service.sendMessage(agent.id, 'Ask the analyst');
    // Let the detached turn run to its early return.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The pause path records no terminal state_change here —
    // PauseAndResumeService owns the completion once the consultation resolves.
    expect(emitted.some(isTerminal)).toBe(false);
    expect(mockCheckpointer.end).toHaveBeenCalled();
  });

  it('emits the persisted output as a completed event when complete_task raced to Completed mid-turn', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    compiledGraph.getState.mockResolvedValue({
      values: { messages: [] },
      next: ['agent'],
    });
    agentRepo.findOneBy.mockResolvedValueOnce(agent).mockResolvedValue({
      ...agent,
      status: AgentStatus.Completed,
      output: 'Already completed via complete_task.',
    });
    roleRepo.findOneBy.mockResolvedValue(role);

    const events = await sendAndCollect(agent.id, 'Ask the analyst');

    expect(completedResponse(events)).toBe(
      'Already completed via complete_task.',
    );
    expect(mockCheckpointer.end).toHaveBeenCalled();
  });

  it('injects role prompt as second message when rolePrompt is set', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ rolePrompt: 'You are an expert analyst.' });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    await sendAndCollect(agent.id, 'Hello');

    const texts = streamedMessages().map((m) => m.content);
    expect(texts).toContain('You are an expert analyst.');
  });

  it('skips role prompt injection when rolePrompt is null', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ rolePrompt: null });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    await sendAndCollect(agent.id, 'Hello');

    // System prompt + task + final instruction = 3 messages; no role prompt
    expect(streamedMessages()).toHaveLength(3);
  });

  it('injects company context when companyContext is set', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue({
      id: agent.companyId,
      companyContext: 'We are ACME, a simulation company.',
    });

    await sendAndCollect(agent.id, 'Hello');

    const texts = streamedMessages().map((m) => m.content);
    expect(texts).toContain('We are ACME, a simulation company.');
  });

  it('appends final instruction as last message on first turn', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    await sendAndCollect(agent.id, 'Hello');

    const messages = streamedMessages();
    expect(messages[messages.length - 1].content).toMatch(/Proceed now/);
  });

  it('renders prompt part 4 as the chat mode prompt plus the user message on the first turn', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ rolePrompt: null });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    await sendAndCollect(agent.id, 'What should I do?');

    // System prompt + part 4 + final instruction = 3; part 4 carries the chat
    // mode prompt so the agent knows it is in a conversation.
    const messages = streamedMessages();
    expect(messages[1].content).toBe(
      `${MODE_PROMPTS.chat}\n\nWhat should I do?`,
    );
  });

  it('does not append final instruction on subsequent turns', async () => {
    const agent = makeAgent({ threadId: randomUUID() });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    await sendAndCollect(agent.id, 'Follow-up');

    // Subsequent turns pass only the single new message
    expect(streamedMessages()).toHaveLength(1);
  });

  it('injects RAG chunks as prompt part 5 when retrieval returns results', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue({
      id: agent.companyId,
      embeddingConfig: { provider: 'lm-studio', model: 'nomic-embed-text' },
    });

    ragRetrieval.retrieve.mockResolvedValue([
      {
        id: randomUUID(),
        documentPath: 'knowledge/analyst/handbook.md',
        chunkIndex: 0,
        content: 'Always cite your sources.',
        similarity: 0.92,
      },
    ]);

    await sendAndCollect(agent.id, 'Hello');

    const texts = streamedMessages().map((m) => m.content);
    expect(texts.some((t) => t.includes('Always cite your sources.'))).toBe(
      true,
    );
    expect(texts.some((t) => t.includes('handbook.md'))).toBe(true);
  });

  it('omits RAG message when retrieval returns no results', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ rolePrompt: null });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue({
      id: agent.companyId,
      embeddingConfig: { provider: 'lm-studio', model: 'nomic-embed-text' },
    });
    ragRetrieval.retrieve.mockResolvedValue([]);

    await sendAndCollect(agent.id, 'Hello');

    // System prompt + task + final instruction = 3 (no role prompt, no RAG)
    expect(streamedMessages()).toHaveLength(3);
  });
});
