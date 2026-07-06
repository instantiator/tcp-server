import { NotFoundException } from '@nestjs/common';
import { randomUUID, UUID } from 'crypto';
import {
  AgentEvent,
  AgentStatus,
  AuditEventType,
  ContextBudgetService,
  ContextCompactorService,
  ContextManagerService,
  IncomingDataGuardService,
  LcpAgent,
  LcpRole,
} from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';

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

jest.mock('@lcp/shared', () => {
  const actual =
    jest.requireActual<typeof import('@lcp/shared')>('@lcp/shared');
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
import { AIMessage } from '@langchain/core/messages';
import { StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { AgentEventService } from '../events/agent-event.service';
import { RagRetrievalService } from '../rag/rag-retrieval.service';

function makeAgent(overrides: Partial<LcpAgent> = {}): LcpAgent {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    roleId: randomUUID(),
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: '',
    output: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
    version: 1,
    ...overrides,
  };
}

function makeRole(overrides: Partial<LcpRole> = {}): LcpRole {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
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

/** Extracts the response text from a `completed` event, if present. */
function completedResponse(events: AgentEvent[]): string | undefined {
  const event = events.find((e) => e.kind === 'completed');
  return event && event.kind === 'completed' ? event.data.response : undefined;
}

describe('ChatService', () => {
  let agentRepo: { findOneBy: jest.Mock; update: jest.Mock };
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
    agentRepo = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
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
    contextManager = new ContextManagerService(
      budget,
      compactor,
      guard,
      agentEvents,
      auditService,
    );

    ragRetrieval = { retrieve: jest.fn().mockResolvedValue([]) };
    mcpClient = { loadTools: jest.fn().mockResolvedValue([]) };

    service = new ChatService(
      config,
      contextManager,
      agentEvents,
      ragRetrieval as unknown as RagRetrievalService,
      auditService as unknown as AuditService,
      mcpClient as never,
      agentRepo as never,
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
  ): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const done = new Promise<void>((resolve) => {
      const sub = agentEvents.observe(agentId).subscribe((event) => {
        events.push(event);
        if (event.kind === 'completed' || event.kind === 'failed') {
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
    companyRepo.findOneBy.mockResolvedValue({ llmDefault: null });
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
    companyRepo.findOneBy.mockResolvedValue({ llmDefault: null });
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

    expect(events.some((e) => e.kind === 'failed')).toBe(true);
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
    // PostgresSaver.end() must always be called to release the connection
    expect(mockCheckpointer.end).toHaveBeenCalled();
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

    const emitted: AgentEvent[] = [];
    agentEvents.observe(agent.id).subscribe((e) => emitted.push(e));
    await service.sendMessage(agent.id, 'Ask the analyst');
    // Let the detached turn run to its early return.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The pause path emits no terminal event here — PauseAndResumeService owns
    // the completion once the consultation resolves.
    expect(emitted.some((e) => e.kind === 'completed')).toBe(false);
    expect(emitted.some((e) => e.kind === 'failed')).toBe(false);
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
