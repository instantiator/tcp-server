import {
  AgentStatus,
  AuditEventType,
  TcpAgent,
  StreamDelta,
  WireEvent,
} from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { EMPTY, firstValueFrom, of, take, toArray } from 'rxjs';
import { DbService } from '../db/db.service';
import { AgentEventService } from '../events/agent-event.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { AgentController } from './api.agent.controller';
import { AssignmentCompletionService } from './assignment-completion.service';
import { AssignmentService } from './assignment.service';
import { ChatService } from './chat.service';
import { SystemShutdownService } from './system-shutdown.service';

function makeAgent(overrides: Partial<TcpAgent> = {}): TcpAgent {
  return {
    id: randomUUID(),
    companyId: randomUUID(),
    roleId: randomUUID(),
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: 'Do something.',
    assignmentId: randomUUID(),
    assignment: {} as never,
    output: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
    version: 1,
    ...overrides,
  };
}

describe('AgentController', () => {
  let db: jest.Mocked<
    Pick<DbService, 'getAgent' | 'createAgent' | 'deleteAgent'>
  >;
  let orchestration: jest.Mocked<
    Pick<
      AgentOrchestrationService,
      'startAgent' | 'resumeAgent' | 'createAgent'
    >
  >;
  let chat: jest.Mocked<Pick<ChatService, 'sendMessage'>>;
  let agentEvents: jest.Mocked<
    Pick<AgentEventService, 'observe' | 'emit' | 'cleanup'>
  >;
  let auditService: { record: jest.Mock };
  let shutdown: SystemShutdownService;
  let assignments: jest.Mocked<Pick<AssignmentService, 'getAgentAssignment'>>;
  let completion: jest.Mocked<
    Pick<AssignmentCompletionService, 'completeChat'>
  >;
  let controller: AgentController;

  beforeEach(() => {
    db = {
      getAgent: jest.fn(),
      createAgent: jest.fn(),
      deleteAgent: jest.fn(),
    };
    orchestration = {
      startAgent: jest.fn(),
      resumeAgent: jest.fn(),
      createAgent: jest.fn(),
    };
    chat = { sendMessage: jest.fn() };
    agentEvents = {
      observe: jest.fn().mockReturnValue(EMPTY),
      emit: jest.fn(),
      cleanup: jest.fn(),
    };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    // Real instance: in-memory state only, so a spec can drive it directly.
    shutdown = new SystemShutdownService();
    assignments = { getAgentAssignment: jest.fn() };
    completion = { completeChat: jest.fn() };
    controller = new AgentController(
      db as unknown as DbService,
      orchestration as unknown as AgentOrchestrationService,
      chat as unknown as ChatService,
      agentEvents as unknown as AgentEventService,
      auditService as never,
      shutdown,
      assignments as unknown as AssignmentService,
      completion as unknown as AssignmentCompletionService,
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

    it('refuses to start an agent while the system is draining', async () => {
      shutdown.begin(false);

      await expect(
        controller.startAgent({
          companyId: randomUUID(),
          roleId: randomUUID(),
          initialPrompt: 'Do something.',
        }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(orchestration.startAgent).not.toHaveBeenCalled();
    });
  });

  describe('startChat', () => {
    it('refuses to start a chat agent while the system is draining', async () => {
      shutdown.begin(false);

      await expect(
        controller.startChat({ companyId: randomUUID(), roleId: randomUUID() }),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(orchestration.createAgent).not.toHaveBeenCalled();
    });

    // 002.02 stage 2: startChat used to call db.createAgent directly and
    // write its own (entity-less) audit record. It now delegates to
    // orchestration.createAgent, whose publish — with entity:'agent' and a
    // summary — is the single agent-creation event; there is no longer a
    // separate one here to assert on.
    it('delegates to orchestration.createAgent in chat mode and returns the agent', async () => {
      const agent = makeAgent({ initialPrompt: '' });
      orchestration.createAgent.mockResolvedValue(agent);

      const result = await controller.startChat({
        companyId: agent.companyId,
        roleId: agent.roleId,
      });

      expect(orchestration.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          companyId: agent.companyId,
          roleId: agent.roleId,
          mode: 'chat',
        }),
      );
      expect(result.id).toBe(agent.id);
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

  describe('sendMessage', () => {
    it('delegates to chat.sendMessage and returns 202 accepted', async () => {
      chat.sendMessage.mockResolvedValue(undefined);
      const result = await controller.sendMessage(randomUUID(), {
        message: 'Hi',
      });
      expect(chat.sendMessage).toHaveBeenCalledWith(expect.any(String), 'Hi');
      expect(result).toEqual({ accepted: true });
    });

    it('throws BadRequestException when message is empty', async () => {
      await expect(
        controller.sendMessage(randomUUID(), { message: '' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-throws NotFoundException from ChatService', async () => {
      chat.sendMessage.mockRejectedValue(
        new NotFoundException('Agent not found'),
      );
      await expect(
        controller.sendMessage(randomUUID(), { message: 'Hi' }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('completeChat', () => {
    /** The `{ assignment, task }` shape `AssignmentService` answers with. */
    const assignmentFor = (agent: TcpAgent) => ({
      assignment: { id: agent.assignmentId, mode: 'chat' } as never,
      task: null,
    });

    it('completes the chat and returns the agent in its new state', async () => {
      const agent = makeAgent();
      assignments.getAgentAssignment.mockResolvedValue(assignmentFor(agent));
      completion.completeChat.mockResolvedValue(undefined);
      db.getAgent.mockResolvedValue(
        makeAgent({ ...agent, status: AgentStatus.Completed }),
      );

      const result = await controller.completeChat(agent.id);

      expect(completion.completeChat).toHaveBeenCalledWith(
        expect.objectContaining({ id: agent.assignmentId }),
      );
      expect(result.status).toBe(AgentStatus.Completed);
    });

    it('propagates a BadRequestException for an assignment that is not a chat', async () => {
      const agent = makeAgent();
      assignments.getAgentAssignment.mockResolvedValue(assignmentFor(agent));
      completion.completeChat.mockRejectedValue(
        new BadRequestException('not a chat'),
      );

      await expect(controller.completeChat(agent.id)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('propagates a ConflictException while a turn is in flight', async () => {
      const agent = makeAgent();
      assignments.getAgentAssignment.mockResolvedValue(assignmentFor(agent));
      completion.completeChat.mockRejectedValue(
        new ConflictException('mid-turn'),
      );

      await expect(controller.completeChat(agent.id)).rejects.toThrow(
        ConflictException,
      );
    });

    it('throws NotFoundException for an unknown agent', async () => {
      assignments.getAgentAssignment.mockRejectedValue(
        new NotFoundException('Agent xyz not found'),
      );

      await expect(controller.completeChat(randomUUID())).rejects.toThrow(
        NotFoundException,
      );
      expect(completion.completeChat).not.toHaveBeenCalled();
    });
  });

  describe('streamEvents (SSE)', () => {
    it('replays a synthesized completed event when the agent already finished', async () => {
      const agent = makeAgent({
        status: AgentStatus.Completed,
        output: 'done',
      });
      db.getAgent.mockResolvedValue(agent);
      agentEvents.observe.mockReturnValue(EMPTY);

      const first = await firstValueFrom(
        controller.streamEvents(agent.id).pipe(take(1)),
      );
      const data = first.data as WireEvent;

      expect(data).toMatchObject({
        type: 'audit',
        event: {
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'agent',
            newStatus: 'completed',
            response: 'done',
          },
        },
      });
    });

    it('replays a synthesized failed state_change when the agent has failed', async () => {
      const agent = makeAgent({ status: AgentStatus.Failed });
      db.getAgent.mockResolvedValue(agent);
      agentEvents.observe.mockReturnValue(EMPTY);

      const first = await firstValueFrom(
        controller.streamEvents(agent.id).pipe(take(1)),
      );
      const data = first.data as WireEvent;

      expect(data.type).toBe('audit');
      if (data.type === 'audit') {
        expect(data.event.payload.newStatus).toBe('failed');
      }
    });

    it('does not replay a terminal event while the agent is still running', async () => {
      const agent = makeAgent({ status: AgentStatus.Running });
      db.getAgent.mockResolvedValue(agent);
      const live: StreamDelta = {
        type: 'stream',
        agentId: agent.id,
        channel: 'response',
        delta: 'hi',
        timestamp: 't',
      };
      agentEvents.observe.mockReturnValue(of(live));

      const events = await firstValueFrom(
        controller.streamEvents(agent.id).pipe(toArray()),
      );

      expect(events).toHaveLength(1);
      const data0 = events[0].data as WireEvent;
      expect(data0.type).toBe('stream');
    });
  });
});
