import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentStatus, LcpAgent } from '@lcp/shared';
import { Queue } from 'bullmq';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { DbService } from '../db/db.service';

// Prevent BullMQ from trying to open a real Redis connection
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

const MockQueue = Queue as jest.MockedClass<typeof Queue>;

function makeAgent(overrides: Partial<LcpAgent> = {}): LcpAgent {
  return {
    id: 'agent-uuid',
    companyId: 'company-uuid',
    roleId: 'role-uuid',
    status: AgentStatus.Idle,
    threadId: null,
    initialPrompt: 'Do something.',
    createdAt: new Date(),
    updatedAt: new Date(),
    company: {} as never,
    role: {} as never,
    ...overrides,
  };
}

describe('AgentOrchestrationService', () => {
  let service: AgentOrchestrationService;
  let mockDb: jest.Mocked<Pick<DbService, 'createAgent' | 'getAgent'>>;
  let mockQueueInstance: { add: jest.Mock; close: jest.Mock };

  beforeEach(async () => {
    mockDb = {
      createAgent: jest.fn(),
      getAgent: jest.fn(),
    };

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
        companyId: 'company-uuid',
        roleId: 'role-uuid',
        initialPrompt: 'Do something.',
      });

      expect(mockDb.createAgent).toHaveBeenCalledWith({
        companyId: 'company-uuid',
        roleId: 'role-uuid',
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

      await expect(service.resumeAgent('missing')).rejects.toThrow('not found');
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
  });
});
