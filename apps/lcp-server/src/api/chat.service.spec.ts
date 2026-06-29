import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentStatus, AuditEventType, LcpAgent, LcpRole } from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service';

// Mock heavy LangGraph + LLM deps before importing ChatService
jest.mock('@langchain/langgraph', () => ({
  StateGraph: jest.fn().mockReturnValue({
    addNode: jest.fn().mockReturnThis(),
    addEdge: jest.fn().mockReturnThis(),
    addConditionalEdges: jest.fn().mockReturnThis(),
    compile: jest.fn().mockReturnValue({
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
import { ContextBudgetService } from '../context/context-budget.service';
import { ContextCompactorService } from '../context/context-compactor.service';
import { IncomingDataGuardService } from '../context/incoming-data-guard.service';
import { ContextManagerService } from '../context/context-manager.service';
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

describe('ChatService', () => {
  let agentRepo: { findOneBy: jest.Mock; update: jest.Mock };
  let roleRepo: { findOneBy: jest.Mock };
  let companyRepo: { findOneBy: jest.Mock };
  let auditService: { write: jest.Mock; record: jest.Mock };
  let config: ConfigService;
  let service: ChatService;
  let compiledGraph: {
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
      invoke: jest.fn(),
      getState: jest.fn().mockResolvedValue({ values: { messages: [] } }),
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
    agentEvents = new AgentEventService();
    contextManager = new ContextManagerService(
      budget,
      compactor,
      guard,
      agentEvents,
      auditService as unknown as AuditService,
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

  afterEach(() => {
    agentEvents.onModuleDestroy();
  });

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

    const aiMsg = new AIMessage('Response via env fallback.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    const result = await service.sendMessage(agent.id, 'Hello');
    expect(result.response).toBe('Response via env fallback.');
  });

  it('sends the first message with system prompt prepended', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);

    const aiMsg = new AIMessage('Hi there!');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    const result = await service.sendMessage(agent.id, 'Hello');

    expect(result.response).toBe('Hi there!');
    // threadId should be set on first call
    expect(agentRepo.update).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ threadId: agent.id }),
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

  it('does not prepend system prompt on subsequent messages', async () => {
    const agent = makeAgent({ threadId: randomUUID() });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);

    const aiMsg = new AIMessage('Got it.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    const result = await service.sendMessage(agent.id, 'Follow-up');
    expect(result.response).toBe('Got it.');

    // threadId should NOT be set again
    expect(agentRepo.update).not.toHaveBeenCalledWith(
      agent.id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      expect.objectContaining({ threadId: expect.any(String) }),
    );
  });

  it('sets agent status to Failed and throws on LLM error', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    compiledGraph.invoke.mockRejectedValue(new Error('LLM down'));

    await expect(service.sendMessage(agent.id, 'Hello')).rejects.toThrow(
      InternalServerErrorException,
    );
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
    // PostgresSaver.end() must always be called to release connection
    expect(mockCheckpointer.end).toHaveBeenCalled();
  });

  it('injects role prompt as second message when rolePrompt is set', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ rolePrompt: 'You are an expert analyst.' });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Hello');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    const texts = messages.map((m) => m.content);
    expect(texts).toContain('You are an expert analyst.');
  });

  it('skips role prompt injection when rolePrompt is null', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole({ rolePrompt: null });
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Hello');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    // System prompt + task + final instruction = 3 messages; no role prompt
    expect(messages).toHaveLength(3);
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

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Hello');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    const texts = messages.map((m) => m.content);
    expect(texts).toContain('We are ACME, a simulation company.');
  });

  it('appends final instruction as last message on first turn', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Hello');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    const lastContent = messages[messages.length - 1].content;
    expect(lastContent).toMatch(/Proceed now/);
  });

  it('does not append final instruction on subsequent turns', async () => {
    const agent = makeAgent({ threadId: randomUUID() });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);
    companyRepo.findOneBy.mockResolvedValue(null);

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Follow-up');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    // Subsequent turns pass only the single new message
    expect(messages).toHaveLength(1);
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

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Hello');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    const texts = messages.map((m) => m.content);
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

    const aiMsg = new AIMessage('Response.');
    compiledGraph.invoke.mockResolvedValue({ messages: [aiMsg] });

    await service.sendMessage(agent.id, 'Hello');

    const { messages } = (
      compiledGraph.invoke.mock.calls[0] as [
        { messages: { content: string }[] },
      ]
    )[0];
    // System prompt + task + final instruction = 3 (no role prompt, no RAG)
    expect(messages).toHaveLength(3);
  });

  it('returns Idle status and empty response when aborted by client', async () => {
    const agent = makeAgent({ threadId: null });
    const role = makeRole();
    agentRepo.findOneBy.mockResolvedValue(agent);
    roleRepo.findOneBy.mockResolvedValue(role);

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    compiledGraph.invoke.mockRejectedValue(abortError);

    const controller = new AbortController();
    controller.abort();

    const result = await service.sendMessage(
      agent.id,
      'Hello',
      controller.signal,
    );

    expect(result.response).toBe('');
    expect(agentRepo.update).toHaveBeenCalledWith(
      agent.id,
      expect.objectContaining({ status: AgentStatus.Idle }),
    );
    // Should write a StateChange audit (cancelled) but not LlmResponse
    expect(auditService.record).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      AuditEventType.StateChange,
      expect.any(Object),
    );
    expect(mockCheckpointer.end).toHaveBeenCalled();
  });
});
