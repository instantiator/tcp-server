import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  Conversation,
  ConversationMessage,
  TcpAgent,
  PendingConsultation,
} from '@tcp/shared';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { DbService } from '../db/db.service';
import { AuditService } from '../audit/audit.service';
import {
  AgentOrchestrationService,
  ALL_REASONS,
} from './agent-orchestration.service';
import { SystemShutdownService } from './system-shutdown.service';

// Prevent BullMQ from trying to open a real Redis connection
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  })),
}));

// The startup Redis reachability probe would otherwise open a real connection;
// unit tests have no Redis, so stub it to resolve.
jest.mock('@tcp/shared', () => ({
  ...jest.requireActual<typeof import('@tcp/shared')>('@tcp/shared'),
  assertRedisReachable: jest.fn().mockResolvedValue(undefined),
}));

const MockQueue = Queue as jest.MockedClass<typeof Queue>;

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
    rateLimitRetries: 0,
    ...overrides,
  };
}

/**
 * Mocks the chainable `createQueryBuilder().update().set().where().andWhere()
 * .execute()` call `resumeAgent` uses to atomically claim a pause episode's
 * resume. `execute` defaults to `{ affected: 1 }` (claim succeeds); tests
 * simulating a losing concurrent call override it to `{ affected: 0 }`.
 */
function makeUpdateQueryBuilder() {
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return qb;
}

function makeRepo() {
  const updateQueryBuilder = makeUpdateQueryBuilder();
  return {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    findOneBy: jest.fn().mockResolvedValue(null),
    createQueryBuilder: jest.fn().mockReturnValue(updateQueryBuilder),
    updateQueryBuilder,
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
  let auditRepo: { exists: jest.Mock<Promise<boolean>, [unknown]> };
  let recordAudit: jest.Mock;
  let shutdown: SystemShutdownService;

  /**
   * Builds the service against the mocks assigned in `beforeEach`, *without*
   * running `onModuleInit` — so a spec can exercise the pre-connection state.
   */
  async function compileService(): Promise<AgentOrchestrationService> {
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
        { provide: getRepositoryToken(TcpAgent), useValue: agentRepo },
        {
          provide: getRepositoryToken(PendingConsultation),
          useValue: consultRepo,
        },
        { provide: getRepositoryToken(Conversation), useValue: convRepo },
        {
          provide: getRepositoryToken(ConversationMessage),
          useValue: msgRepo,
        },
        { provide: getRepositoryToken(AuditEvent), useValue: auditRepo },
        { provide: AuditService, useValue: { record: recordAudit } },
        // Real instance: it holds only in-memory state and no collaborators,
        // so a spec that needs the draining behaviour can just call begin().
        SystemShutdownService,
      ],
    }).compile();

    shutdown = testingModule.get(SystemShutdownService);
    return testingModule.get(AgentOrchestrationService);
  }

  beforeEach(async () => {
    mockDb = {
      createAgent: jest.fn(),
      getAgent: jest.fn(),
    };
    recordAudit = jest.fn().mockResolvedValue(undefined);
    agentRepo = makeRepo();
    consultRepo = makeRepo();
    convRepo = makeRepo();
    msgRepo = makeRepo();
    auditRepo = {
      exists: jest.fn((_options: unknown) => Promise.resolve(false)),
    };

    service = await compileService();
    await service.onModuleInit();
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

  describe('onModuleDestroy', () => {
    it('closes the queue when one was opened', async () => {
      await service.onModuleDestroy();
      expect(mockQueueInstance.close).toHaveBeenCalled();
    });

    it('resolves when startup never opened a queue, so teardown cannot mask the startup error', async () => {
      const neverStarted = await compileService();
      await expect(neverStarted.onModuleDestroy()).resolves.toBeUndefined();
    });

    it('swallows a close that rejects against a dead connection', async () => {
      mockQueueInstance.close.mockRejectedValue(
        new Error('Connection is closed'),
      );
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
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

  describe('createAgent', () => {
    // 002.02 stage 1 (cause C1): a new agent row was written with no event, so
    // a client only learned of it from its first `running` — which, queued
    // behind another job, came 52 s later. Stage 2 publishes it on create.
    it('publishes the new agent as idle, with a summary, after its row is written', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      mockDb.createAgent.mockResolvedValue(agent);

      await service.createAgent({
        companyId: agent.companyId,
        roleId: agent.roleId,
        initialPrompt: 'Do something.',
        assignmentId: agent.assignmentId,
      });

      expect(recordAudit).toHaveBeenCalledWith(
        agent.companyId,
        expect.any(String),
        agent.id,
        AuditEventType.StateChange,
        expect.objectContaining({
          entity: 'agent',
          newStatus: AgentStatus.Idle,
          summary: expect.objectContaining({
            id: agent.id,
            status: AgentStatus.Idle,
          }) as unknown,
        }),
      );
      // Persist, then publish: a client that refetches on this event must
      // find the row.
      expect(mockDb.createAgent.mock.invocationCallOrder[0]).toBeLessThan(
        recordAudit.mock.invocationCallOrder[0],
      );
    });
  });

  describe('while the system is draining', () => {
    beforeEach(() => {
      shutdown.begin(false);
    });

    it('refuses to dispatch a start job', async () => {
      await expect(service.dispatchStartJob(randomUUID())).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(mockQueueInstance.add).not.toHaveBeenCalled();
    });

    it('refuses to dispatch a resume job', async () => {
      const agent = makeAgent({ status: AgentStatus.Paused });
      mockDb.getAgent.mockResolvedValue(agent);

      await expect(service.resumeAgent(agent.id)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(mockQueueInstance.add).not.toHaveBeenCalled();
    });

    it('dispatches again once the drain is cancelled', async () => {
      shutdown.cancel();
      await service.dispatchStartJob(randomUUID());
      expect(mockQueueInstance.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('dispatchStartJob on a paused task', () => {
    it('creates the agent paused instead of queueing it', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      agentRepo.findOne.mockResolvedValue({
        ...agent,
        assignment: { task: { pausedAt: new Date() } },
      });

      await service.dispatchStartJob(agent.id);

      expect(mockQueueInstance.add).not.toHaveBeenCalled();
      expect(agentRepo.update).toHaveBeenCalledWith(
        { id: agent.id, status: AgentStatus.Idle },
        expect.objectContaining({
          status: AgentStatus.Paused,
          pauseReason: 'manual',
        }),
      );
    });

    it('queues as usual when the task is not paused', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      agentRepo.findOne.mockResolvedValue({
        ...agent,
        assignment: { task: {} },
      });

      await service.dispatchStartJob(agent.id);

      expect(mockQueueInstance.add).toHaveBeenCalledTimes(1);
    });
  });

  describe('resumeAgent', () => {
    it('injects a continuation prompt when resuming a shutdown-paused agent, so tcp-agent continues from the checkpoint rather than restarting', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
        pauseReason: 'shutdown',
      });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.count.mockResolvedValue(0);
      convRepo.count.mockResolvedValue(0);

      await service.resumeAgent(agent.id, undefined, { lifts: ALL_REASONS });

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
        replyContent: expect.stringContaining(
          'Continue from where you left off',
        ) as string,
      });
    });

    describe('resuming a spend-cap-paused agent', () => {
      /** Resumes a cap-paused agent and returns the queued job's replyContent. */
      async function resumeCapPaused(started: boolean): Promise<unknown> {
        const agent = makeAgent({
          status: AgentStatus.Paused,
          pausedAt: new Date(),
          pauseReason: 'spend_cap',
        });
        mockDb.getAgent.mockResolvedValue(agent);
        auditRepo.exists.mockResolvedValue(started);

        await service.resumeAgent(agent.id, undefined, { lifts: ALL_REASONS });

        const [, job] = mockQueueInstance.add.mock.calls[0] as [
          string,
          { replyContent?: unknown },
        ];
        return job.replyContent;
      }

      it('continues from the checkpoint when the agent had already called its LLM', async () => {
        expect(await resumeCapPaused(true)).toEqual(
          expect.stringContaining('spending limit'),
        );
      });

      it('restarts with no message when the cap held it back before its first LLM call', async () => {
        expect(await resumeCapPaused(false)).toBeUndefined();
      });
    });

    // A rate limit strikes inside the graph, after it has checkpointed, so a
    // restart would replay the opening prompt on top of that checkpoint.
    it('continues a rate-limited agent from its checkpoint, even before its first response', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
        pauseReason: 'rate_limited',
      });
      mockDb.getAgent.mockResolvedValue(agent);
      auditRepo.exists.mockResolvedValue(false);

      await service.resumeAgent(agent.id, undefined, { lifts: ALL_REASONS });

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
        replyContent: expect.stringContaining(
          'model provider was temporarily refusing',
        ) as string,
      });
    });

    describe('a manual pause', () => {
      /** Resumes a manually paused agent and returns the queued job's replyContent. */
      async function resumeManual(started: boolean): Promise<unknown> {
        const agent = makeAgent({
          status: AgentStatus.Paused,
          pausedAt: new Date(),
          pauseReason: 'manual',
        });
        mockDb.getAgent.mockResolvedValue(agent);
        auditRepo.exists.mockResolvedValue(started);
        await service.resumeAgent(agent.id, undefined, {
          lifts: ALL_REASONS,
          taskResume: true,
        });
        const [, job] = mockQueueInstance.add.mock.calls[0] as [
          string,
          { replyContent?: unknown },
        ];
        return job.replyContent;
      }

      it('continues from the checkpoint when the agent had already called its LLM', async () => {
        expect(await resumeManual(true)).toEqual(
          expect.stringContaining('A user paused your work'),
        );
      });

      it('restarts with no message when the agent was paused before its first LLM call', async () => {
        expect(await resumeManual(false)).toBeUndefined();
      });
    });

    describe('a restart pause', () => {
      /** Resumes an agent paused for a restart, as boot recovery does. */
      async function resumeRestart(started: boolean): Promise<unknown> {
        const agent = makeAgent({
          status: AgentStatus.Paused,
          pausedAt: new Date(),
          pauseReason: 'restart',
        });
        mockDb.getAgent.mockResolvedValue(agent);
        auditRepo.exists.mockResolvedValue(started);
        await service.resumeAgent(agent.id, undefined, { lifts: ['restart'] });
        const [, job] = mockQueueInstance.add.mock.calls[0] as [
          string,
          { replyContent?: unknown },
        ];
        return job.replyContent;
      }

      it('continues from the checkpoint when the agent had already called its LLM', async () => {
        expect(await resumeRestart(true)).toEqual(
          expect.stringContaining('The system restarted'),
        );
      });

      it('restarts with no message when the agent never reached its first LLM call', async () => {
        expect(await resumeRestart(false)).toBeUndefined();
      });
    });

    // A reply must not wake an agent paused for something else: a spend-capped
    // agent woken this way re-paused at the gate, and the reply — already
    // marked delivered — was lost.
    it.each([
      'spend_cap',
      'rate_limited',
      'shutdown',
      'manual',
      'restart',
    ] as const)(
      'leaves a %s pause alone on a reply, without claiming it',
      async (pauseReason) => {
        const agent = makeAgent({
          status: AgentStatus.Paused,
          pausedAt: new Date(),
          pauseReason,
        });
        mockDb.getAgent.mockResolvedValue(agent);

        await service.resumeAgent(agent.id);

        expect(mockQueueInstance.add).not.toHaveBeenCalled();
        expect(agentRepo.updateQueryBuilder.execute).not.toHaveBeenCalled();
      },
    );

    it('refuses any resume but the task resume while the task is paused', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
        pauseReason: 'user_input',
      });
      mockDb.getAgent.mockResolvedValue(agent);
      agentRepo.findOne.mockResolvedValue({
        ...agent,
        assignment: { task: { pausedAt: new Date() } },
      });

      await expect(service.resumeAgent(agent.id)).rejects.toThrow(
        'This task is paused',
      );
      expect(mockQueueInstance.add).not.toHaveBeenCalled();
    });

    it('enqueues a resume job for an idle agent', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      mockDb.getAgent.mockResolvedValue(agent);

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).toHaveBeenCalledWith('resume', {
        agentId: agent.id,
        type: 'resume',
      });
    });

    // 002.02 stage 2: an early `running` here raced ahead of the database,
    // which still read `paused` until the worker actually picked the job up.
    // 000.03: enqueueing now publishes `queued` instead — persisted first, so
    // the database agrees — and the worker's own `running` write remains the
    // only `running` event.
    it('publishes queued, never running, once the job is enqueued', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      mockDb.getAgent.mockResolvedValue(agent);
      agentRepo.findOneBy.mockResolvedValue({
        ...agent,
        status: AgentStatus.Queued,
      });

      await service.resumeAgent(agent.id);

      expect(recordAudit).toHaveBeenCalledTimes(1);
      expect(recordAudit).toHaveBeenCalledWith(
        agent.companyId,
        'agent',
        agent.id,
        AuditEventType.StateChange,
        expect.objectContaining({ newStatus: AgentStatus.Queued }),
      );
    });

    it('publishes nothing when the worker has already moved the agent on', async () => {
      const agent = makeAgent({ status: AgentStatus.Idle });
      mockDb.getAgent.mockResolvedValue(agent);
      // markQueued's conditional update matches no row: the agent is running.
      agentRepo.updateQueryBuilder.execute.mockResolvedValue({ affected: 0 });

      await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
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

    it('aggregates every undelivered response into one replyContent', async () => {
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
      msgRepo.find.mockResolvedValue([{ content: 'User answer.' }]);

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

    it('delivers every user message in a conversation, oldest first', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
      });
      mockDb.getAgent.mockResolvedValue(agent);
      convRepo.find.mockResolvedValue([{ id: randomUUID() }]);
      msgRepo.find.mockResolvedValue([
        { content: 'First half of my answer.' },
        { content: 'And the second half.' },
      ]);

      await service.resumeAgent(agent.id);

      // A user who answers across two messages has said two things. Taking
      // only the most recent silently discards the rest of the answer.
      const [, payload] = mockQueueInstance.add.mock.calls[0] as [
        string,
        { replyContent: string },
      ];
      expect(payload.replyContent).toBe(
        'User response: First half of my answer.\n\n' +
          'User response: And the second half.',
      );
      const [[where]] = msgRepo.find.mock.calls as [[{ order: object }]];
      expect(where.order).toEqual({ timestamp: 'ASC' });
    });

    it('scopes replies by delivery state, never by a timestamp comparison', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
      });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.find.mockResolvedValue([
        { id: randomUUID(), status: 'complete', result: 'All good.' },
      ]);

      await service.resumeAgent(agent.id);

      // The bug this guards: `createdAt` is stamped by the database's clock and
      // `pausedAt` by this process's, so comparing them dropped an answer
      // whenever the two disagreed by a millisecond — and the agent resumed
      // knowing nothing about the question it had asked.
      const [[consultWhere], [convWhere]] = [
        consultRepo.find.mock.calls[0] as [{ where: object }],
        convRepo.find.mock.calls[0] as [{ where: object }],
      ];
      expect(consultWhere.where).not.toHaveProperty('createdAt');
      expect(convWhere.where).not.toHaveProperty('createdAt');
    });

    it('marks delivered replies so a later resume cannot repeat them', async () => {
      const consultationId = randomUUID();
      const conversationId = randomUUID();
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
      });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.find.mockResolvedValue([
        { id: consultationId, status: 'complete', result: 'All good.' },
      ]);
      convRepo.find.mockResolvedValue([{ id: conversationId }]);
      msgRepo.find.mockResolvedValue([{ content: 'User answer.' }]);

      await service.resumeAgent(agent.id);

      expect(consultRepo.update).toHaveBeenCalledWith([consultationId], {
        status: 'consumed',
      });
      expect(convRepo.update).toHaveBeenCalledWith([conversationId], {
        repliesDeliveredAt: expect.any(Date) as Date,
      });
    });

    it('leaves replies undelivered when the resume job cannot be queued', async () => {
      const agent = makeAgent({
        status: AgentStatus.Paused,
        pausedAt: new Date(),
      });
      mockDb.getAgent.mockResolvedValue(agent);
      consultRepo.find.mockResolvedValue([
        { id: randomUUID(), status: 'complete', result: 'All good.' },
      ]);
      mockQueueInstance.add.mockRejectedValueOnce(new Error('queue is down'));

      await expect(service.resumeAgent(agent.id)).rejects.toThrow(
        'queue is down',
      );

      // Marking them consumed here would strand the answer: the agent never
      // gets the job, and the next resume would find nothing left to give it.
      expect(consultRepo.update).not.toHaveBeenCalled();
    });

    it('clears pausedAt via an atomic conditional update after a successful resume', async () => {
      const pausedAt = new Date();
      const agent = makeAgent({ status: AgentStatus.Paused, pausedAt });
      mockDb.getAgent.mockResolvedValue(agent);

      await service.resumeAgent(agent.id);

      expect(agentRepo.createQueryBuilder).toHaveBeenCalled();
      expect(agentRepo.updateQueryBuilder.set).toHaveBeenCalledWith({
        pausedAt: expect.any(Function) as () => string,
        pauseReason: expect.any(Function) as () => string,
      });
      expect(agentRepo.updateQueryBuilder.where).toHaveBeenCalledWith(
        'id = :agentId',
        { agentId: agent.id },
      );
      expect(agentRepo.updateQueryBuilder.andWhere).toHaveBeenCalledWith(
        'pausedAt = :pausedAt',
        { pausedAt },
      );
    });

    it('skips enqueueing a duplicate resume job when a concurrent call already claimed the pause episode', async () => {
      const pausedAt = new Date();
      const agent = makeAgent({ status: AgentStatus.Paused, pausedAt });
      mockDb.getAgent.mockResolvedValue(agent);
      // Simulate losing the race: another call already cleared pausedAt.
      agentRepo.updateQueryBuilder.execute.mockResolvedValue({ affected: 0 });

      const result = await service.resumeAgent(agent.id);

      expect(mockQueueInstance.add).not.toHaveBeenCalled();
      expect(recordAudit).not.toHaveBeenCalled();
      expect(result.id).toBe(agent.id);
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
