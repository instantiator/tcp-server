import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentStatus, AuditEventType, LcpAgent, LcpRole } from '@lcp/shared';
import { ConfigService } from '@nestjs/config';

// Mock the heavy LangGraph + LLM deps before importing ChatService
jest.mock('@langchain/langgraph', () => ({
  StateGraph: jest.fn().mockReturnValue({
    addNode: jest.fn().mockReturnThis(),
    addEdge: jest.fn().mockReturnThis(),
    compile: jest.fn().mockReturnValue({
      invoke: jest.fn(),
    }),
  }),
  MessagesAnnotation: { State: {} },
  END: 'END',
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
    buildChatModel: jest.fn().mockReturnValue({ invoke: jest.fn() }),
  };
});

import { ChatService } from './chat.service';
import { AIMessage } from '@langchain/core/messages';
import { StateGraph } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

function makeAgent(overrides: Partial<LcpAgent> = {}): LcpAgent {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    roleId: randomUUID(),
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
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
    company: {} as never,
    ...overrides,
  };
}

describe('ChatService', () => {
  let agentRepo: { findOneBy: jest.Mock; update: jest.Mock };
  let roleRepo: { findOneBy: jest.Mock };
  let companyRepo: { findOneBy: jest.Mock };
  let auditRepo: { save: jest.Mock; create: jest.Mock };
  let config: ConfigService;
  let service: ChatService;
  let compiledGraph: { invoke: jest.Mock };
  let mockCheckpointer: { setup: jest.Mock; end: jest.Mock };

  beforeEach(() => {
    agentRepo = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    roleRepo = { findOneBy: jest.fn() };
    companyRepo = { findOneBy: jest.fn() };
    auditRepo = {
      save: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockReturnValue({}),
    };
    config = {
      getOrThrow: jest.fn().mockReturnValue('postgres://test'),
    } as unknown as ConfigService;

    mockCheckpointer = {
      setup: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
    };
    (PostgresSaver.fromConnString as jest.Mock).mockReturnValue(
      mockCheckpointer,
    );

    compiledGraph = { invoke: jest.fn() };
    (StateGraph as jest.Mock).mockReturnValue({
      addNode: jest.fn().mockReturnThis(),
      addEdge: jest.fn().mockReturnThis(),
      compile: jest.fn().mockReturnValue(compiledGraph),
    });

    service = new ChatService(
      config,
      agentRepo as never,
      roleRepo as never,
      companyRepo as never,
      auditRepo as never,
    );
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
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: AuditEventType.LlmRequest }),
    );
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: AuditEventType.LlmResponse }),
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
    expect(auditRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: AuditEventType.StateChange }),
    );

    // PostgresSaver.end() must always be called to release connection
    expect(mockCheckpointer.end).toHaveBeenCalled();
  });
});
