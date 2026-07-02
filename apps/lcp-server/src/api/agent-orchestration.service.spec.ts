import {
  AgentStatus,
  Conversation,
  ConversationMessage,
  LcpAgent,
  PendingConsultation,
} from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { AgentOrchestrationService } from './agent-orchestration.service';

// Prevent BullMQ from trying to open a real Redis connection
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
}));

const MockQueue = Queue as jest.MockedClass<typeof Queue>;

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
    version: 1,
    ...overrides,
  };
}

function makeRepo() {
  return {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

describe('AgentOrchestrationService', () => {
  let service: AgentOrchestrationService;
  let mockDb: jest.Mocked<Pick<DbService, 'createAgent' | 'getAgent'>>;
  let mockQueueInstance: { add: jest.Mock; close: jest.Mock };
  let agentRepo: ReturnType<typeof makeRepo>;
  let consultRepo: ReturnType<typeof makeRepo>;
  let convRepo: ReturnType<typeof makeRepo>;
  let msgRepo: ReturnType<typeof makeRepo>;

  beforeEach(async () => {
    mockDb = {
      createAgent: jest.fn(),
      getAgent: jest.fn(),
    };
    agentRepo = makeRepo();
    consultRepo = makeRepo();
    convRepo = makeRepo();
    msgRepo = makeRepo();

    const testingModule: TestingModule = await Test.createTestingModule({
      providers: [
        AgentOrchestrationService,
        { provide: DbService, useValue: mockDb },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379'),
          },
        },
        { provide: getRepositoryToken(LcpAgent), useValue: agentRepo },
        {
          provide: getRepositoryToken(PendingConsultation),
          useValue: consultRepo,
        },
        { provide: getRepositoryToken(Conversation), useValue: convRepo },
        {
          provide: getRepositoryToken(ConversationMessage),
          useValue: msgRepo,
        },
      ],
    }).compile();

    service = testingModule.get(AgentOrchestrationService);
    service.onModuleInit();
    // mock.results[0].value is the object returned by `new Queue(...)`, which
    // has our jest.fn() add/close methods
    mockQueueInstance = MockQueue.mock.results[0].value as {
      add: jest.Mock;
      close: jest.Mock;
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('startAgent', () => {
    it('creates an agent record then enqueues a start job', async () => {
      const agent = makeAgent();
      mockDb.createAgent.mockResolvedValue(agent);

      const result = await service.startAgent({
        companyId: agent.companyId,
        roleId: agent.roleId,
        initialPrompt: 'Do something.',
      });

      expect(mockDb.createAgent).toHaveBeenCalledWith({
        companyId: agent.companyId,
        roleId: agent.roleId,
        initialPrompt: 'Do something.',
      });
      expect(mockQueueInstance.add).toHaveBeenCalledWith('start', {
        agentId: agent.id,
        type: 'start',
      });
      expect(result.id).toBe(agent.id);
    });
  });

  describe('resumeAgent', () => {
    it('enqueues a resume job for an idle agent', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      mockDb.getAgent.mockResolvedValue(agent);

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
      });
    });

    it('enqueues a resume job for a failed agent', async () => {
      const agent = makeAgent({ status: AgentStatus.Failed });
      mockDb.getAgent.mockResolvedValue(agent);

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
      });
    });

    it('throws when the agent does not exist', async () => {
      mockDb.getAgent.mockResolvedValue(null);

      await expect(service.resumeAgent(randomUUID())).rejects.toThrow(
        'not found',
      );
    });

    it('throws when the agent is already running', async () => {
      const agent = makeAgent({ status: AgentStatus.Running });
      mockDb.getAgent.mockResolvedValue(agent);

      await expect(service.resumeAgent(agent.id)).rejects.toThrow(
        "cannot be resumed from status 'running'",
      );
    });

    it('throws when the agent has already completed', async () => {
      const agent = makeAgent({ status: AgentStatus.Completed });
      mockDb.getAgent.mockResolvedValue(agent);

      await expect(service.resumeAgent(agent.id)).rejects.toThrow(
        "cannot be resumed from status 'completed'",
      );
    });

    it('stays paused (does not enqueue) when other consultations are still outstanding', async () => {
      const agent = makeAgent({ status: AgentStatus.Paused });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.count.mockResolvedValue(1);

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).not.toHaveBeenCalled();
      expect(agentRepo.update).not.toHaveBeenCalled();
    });

    it('stays paused (does not enqueue) when a conversation is still awaiting a user reply', async () => {
      const agent = makeAgent({ status: AgentStatus.Paused });
      mockDb.getAgent.mockResolvedValue(agent);
      convRepo.count.mockResolvedValue(1);

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).not.toHaveBeenCalled();
    });

    it('aggregates every response received since pausedAt into one replyContent', async () => {
      const pausedAt = new Date('2026-06-01T00:00:00Z');
      const agent = makeAgent({ status: AgentStatus.Paused, pausedAt });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.find.mockResolvedValue([
        {
          id: randomUUID(),
          status: 'complete',
          result: 'Consultation answer.',
        },
      ]);
      const conversationId = randomUUID();
      convRepo.find.mockResolvedValue([{ id: conversationId }]);
      msgRepo.findOne.mockResolvedValue({ content: 'User answer.' });

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
        replyContent: expect.stringContaining('Consultation answer.') as string,
      });
      const [, payload] = mockQueueInstance.add.mock.calls[0] as [
        string,
        { replyContent: string },
      ];
      expect(payload.replyContent).toContain('User answer.');
    });

    it('includes failed consultations with a FAILED marker and escalation guidance', async () => {
      const pausedAt = new Date('2026-06-01T00:00:00Z');
      const agent = makeAgent({ status: AgentStatus.Paused, pausedAt });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.find.mockResolvedValue([
        { id: randomUUID(), status: 'complete', result: 'All good.' },
        {
          id: randomUUID(),
          status: 'failed',
          result: 'Agent ended without calling complete_task',
        },
      ]);

      await service.resumeAgent(agent.id);

      const [, payload] = mockQueueInstance.add.mock.calls[0] as [
        string,
        { replyContent: string },
      ];
      expect(payload.replyContent).toContain(
        'Consultation response: All good.',
      );
      expect(payload.replyContent).toContain(
        'Consultation FAILED: Agent ended without calling complete_task',
      );
      expect(payload.replyContent).toContain('request_user_input');
    });

    it('clears pausedAt after a successful resume', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
      });
      mockDb.getAgent.mockResolvedValue(agent);

      await service.resumeAgent(agent.id);

      expect(agentRepo.update).toHaveBeenCalledWith(agent.id, {
        pausedAt: expect.any(Function) as () => string,
      });
    });

    it('falls back to the explicit replyContent param when pausedAt is unset', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: undefined,
      });
      mockDb.getAgent.mockResolvedValue(agent);

      await service.resumeAgent(agent.id, 'manual retry content');

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
        replyContent: 'manual retry content',
      });
    });
  });
});
