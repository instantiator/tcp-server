import { AgentStatus, AuditEventType, LcpAgent } from '@lcp/shared';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { randomUUID, UUID } from 'crypto';
import type { Request } from 'express';
import { DbService } from '../db/db.service';
import { AgentEventService } from '../events/agent-event.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { AgentController } from './api.agent.controller';
import { ChatService } from './chat.service';

function makeAgent(overrides: Partial<LcpAgent> = {}): LcpAgent {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    roleId: randomUUID(),
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: 'Do something.',
    output: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
    ...overrides,
  };
}

const mockReq = {
  socket: { on: jest.fn() },
} as unknown as Request;

describe('AgentController', () => {
  let db: jest.Mocked<
    Pick<DbService, 'getAgent' | 'createAgent' | 'deleteAgent'>
  >;
  let orchestration: jest.Mocked<
    Pick<AgentOrchestrationService, 'startAgent' | 'resumeAgent'>
  >;
  let chat: jest.Mocked<Pick<ChatService, 'sendMessage'>>;
  let agentEvents: jest.Mocked<
    Pick<AgentEventService, 'observe' | 'emit' | 'cleanup'>
  >;
  let auditService: { record: jest.Mock };
  let controller: AgentController;

  beforeEach(() => {
    db = {
      getAgent: jest.fn(),
      createAgent: jest.fn(),
      deleteAgent: jest.fn(),
    };
    orchestration = { startAgent: jest.fn(), resumeAgent: jest.fn() };
    chat = { sendMessage: jest.fn() };
    agentEvents = {
      observe: jest.fn().mockReturnValue({ pipe: jest.fn() }),
      emit: jest.fn(),
      cleanup: jest.fn(),
    };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    controller = new AgentController(
      db as unknown as DbService,
      orchestration as unknown as AgentOrchestrationService,
      chat as unknown as ChatService,
      agentEvents as unknown as AgentEventService,
      auditService as never,
    );
  });

  describe('startAgent', () => {
    it('delegates to orchestration.startAgent and returns the agent', async () => {
      const agent = makeAgent();
      orchestration.startAgent.mockResolvedValue(agent);

      const result = await controller.startAgent({
        companyId: agent.companyId,
        roleId: agent.roleId,
        initialPrompt: 'Do something.',
      });

      expect(orchestration.startAgent).toHaveBeenCalledTimes(1);
      expect(result.id).toBe(agent.id);
    });

    it('throws BadRequestException when required fields are missing', async () => {
      await expect(
        controller.startAgent({
          companyId: '' as UUID,
          roleId: randomUUID(),
          initialPrompt: 'Go.',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('resumeAgent', () => {
    it('delegates to orchestration.resumeAgent and returns the agent', async () => {
      const agent = makeAgent();
      orchestration.resumeAgent.mockResolvedValue(agent);
      const result = await controller.resumeAgent(agent.id);
      expect(result.id).toBe(agent.id);
    });

    it('throws NotFoundException when the orchestration service reports agent not found', async () => {
      const id = randomUUID();
      orchestration.resumeAgent.mockRejectedValue(
        new Error('Agent xyz not found'),
      );
      await expect(controller.resumeAgent(id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when the agent cannot be resumed', async () => {
      const id = randomUUID();
      orchestration.resumeAgent.mockRejectedValue(
        new Error("cannot be resumed from status 'running'"),
      );
      await expect(controller.resumeAgent(id)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getAgent', () => {
    it('returns the agent when found', async () => {
      const agent = makeAgent();
      db.getAgent.mockResolvedValue(agent);

      const result = await controller.getAgent(agent.id);
      expect(result.id).toBe(agent.id);
    });

    it('throws NotFoundException when the agent does not exist', async () => {
      db.getAgent.mockResolvedValue(null);
      await expect(controller.getAgent(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('deleteAgent', () => {
    it('calls db.deleteAgent and returns 204 when found', async () => {
      db.deleteAgent.mockResolvedValue(true);
      await expect(
        controller.deleteAgent(randomUUID()),
      ).resolves.toBeUndefined();
    });

    it('throws NotFoundException when the agent does not exist', async () => {
      db.deleteAgent.mockResolvedValue(false);
      await expect(controller.deleteAgent(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('startChat', () => {
    it('creates a chat agent without dispatching to BullMQ and records an audit event', async () => {
      const agent = makeAgent({ initialPrompt: '' });
      db.createAgent.mockResolvedValue(agent);

      const result = await controller.startChat({
        companyId: agent.companyId,
        roleId: agent.roleId,
      });

      expect(db.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: agent.companyId,
          roleId: agent.roleId,
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        AuditEventType.StateChange,
        expect.any(Object),
      );
      expect(result.id).toBe(agent.id);
    });

    it('throws BadRequestException when required fields are missing', async () => {
      await expect(
        controller.startChat({ companyId: '' as UUID, roleId: randomUUID() }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('sendMessage', () => {
    it('delegates to chat.sendMessage and returns the response', async () => {
      chat.sendMessage.mockResolvedValue({ response: 'Hello!' });
      const result = await controller.sendMessage(
        randomUUID(),
        { message: 'Hi' },
        mockReq,
      );
      expect(result.response).toBe('Hello!');
    });

    it('throws BadRequestException when message is empty', async () => {
      await expect(
        controller.sendMessage(randomUUID(), { message: '' }, mockReq),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-throws NotFoundException from ChatService', async () => {
      chat.sendMessage.mockRejectedValue(
        new NotFoundException('Agent not found'),
      );
      await expect(
        controller.sendMessage(randomUUID(), { message: 'Hi' }, mockReq),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
