import { AgentStatus, TcpAgent, TcpTask } from '@tcp/shared';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID, type UUID } from 'crypto';
import { In, type Repository } from 'typeorm';
import { SpendCapService } from '../spend/spend-cap.service';
import {
  AgentOrchestrationService,
  type ResumeOptions,
} from './agent-orchestration.service';
import { SpendResumeService } from './spend-resume.service';
import { SystemShutdownService } from './system-shutdown.service';
import { TaskStateService } from './task-state.service';

describe('SpendResumeService', () => {
  const taskId = randomUUID();
  const companyId = randomUUID();
  /** Records the order of exemption writes, pause clears and resumes. */
  let calls: string[];
  let agents: TcpAgent[];
  let task: TcpTask;
  let caps: jest.Mocked<
    Pick<SpendCapService, 'resetExpired' | 'dismiss' | 'isAnyReached'>
  >;
  let agentFind: jest.Mock<Promise<TcpAgent[]>, [unknown]>;
  let taskUpdate: jest.Mock<Promise<void>, [unknown, Partial<TcpTask>]>;
  let resumeOptions: ResumeOptions[];
  let recordTaskState: jest.Mock;
  let shutdown: SystemShutdownService;
  let service: SpendResumeService;

  const pausedAgent = (
    taskOf: UUID | null,
    taskPausedAt: Date | null = null,
  ): TcpAgent =>
    ({
      id: randomUUID(),
      companyId,
      status: AgentStatus.Paused,
      pauseReason: 'spend_cap',
      assignment: {
        taskId: taskOf,
        task: taskOf ? { id: taskOf, pausedAt: taskPausedAt } : null,
      },
    }) as TcpAgent;

  const build = (findTask: () => Promise<TcpTask | null>) =>
    new SpendResumeService(
      caps as unknown as SpendCapService,
      {
        resumeAgent: (id: UUID, _reply: unknown, options: ResumeOptions) => {
          calls.push(`resume:${id}`);
          resumeOptions.push(options);
          return Promise.resolve({} as TcpAgent);
        },
      } as unknown as AgentOrchestrationService,
      shutdown,
      { find: agentFind } as unknown as Repository<TcpAgent>,
      {
        findOneBy: findTask,
        update: taskUpdate,
      } as unknown as Repository<TcpTask>,
      { recordTaskState } as unknown as TaskStateService,
    );

  beforeEach(() => {
    calls = [];
    resumeOptions = [];
    agents = [pausedAgent(taskId), pausedAgent(null)];
    task = { id: taskId, status: 'in-progress' } as TcpTask;
    caps = {
      resetExpired: jest.fn().mockResolvedValue([]),
      dismiss: jest.fn().mockResolvedValue({}),
      isAnyReached: jest.fn().mockResolvedValue(false),
    };
    agentFind = jest.fn((_options: unknown) => Promise.resolve(agents));
    taskUpdate = jest.fn((_where: unknown, patch: Partial<TcpTask>) => {
      calls.push('spendCapExempt' in patch ? 'exempt' : 'unpause');
      return Promise.resolve();
    });
    recordTaskState = jest.fn().mockResolvedValue(undefined);
    shutdown = new SystemShutdownService();
    service = build(() => Promise.resolve(task));
  });

  describe('resumeTask', () => {
    it('resumes every pause a task resume lifts, as the task resume', async () => {
      const result = await service.resumeTask(taskId);

      expect(agentFind).toHaveBeenCalledWith({
        where: {
          status: AgentStatus.Paused,
          pauseReason: In([
            'spend_cap',
            'shutdown',
            'rate_limited',
            'manual',
            'user_input',
            'consultation',
          ]),
          assignment: { taskId },
        },
      });
      expect(resumeOptions[0]).toEqual(
        expect.objectContaining({ taskResume: true }),
      );
      expect(result.resumed).toBe(2);
    });

    it("doesn't exempt the task from caps when none is reached", async () => {
      await service.resumeTask(taskId);
      expect(calls).not.toContain('exempt');
    });

    it('exempts the task before resuming when a cap is reached', async () => {
      caps.isAnyReached.mockResolvedValue(true);
      await service.resumeTask(taskId);
      expect(calls[0]).toBe('exempt');
    });

    it("clears a user's pause and records it, before resuming", async () => {
      task.pausedAt = new Date();
      task.pausedBy = 'Ada';
      await service.resumeTask(taskId);

      expect(taskUpdate).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ pausedBy: null }),
      );
      expect(calls[0]).toBe('unpause');
      expect(recordTaskState).toHaveBeenCalledWith(
        expect.objectContaining({ pausedAt: undefined, pausedBy: null }),
        'in-progress',
        'resumed by a user',
      );
    });

    it('leaves the pause fields alone on a task no user paused', async () => {
      await service.resumeTask(taskId);
      expect(calls).not.toContain('unpause');
      expect(recordTaskState).not.toHaveBeenCalled();
    });

    it('404s for an unknown task', async () => {
      service = build(() => Promise.resolve(null));
      await expect(service.resumeTask(taskId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('is refused while the system drains', async () => {
      shutdown.begin(false);
      await expect(service.resumeTask(taskId)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  describe('resumeCompany', () => {
    it("resumes the company's paused agents, lifting everything but a user's pause", async () => {
      const result = await service.resumeCompany(companyId);
      expect(result.resumed).toBe(2);
      expect(resumeOptions[0].lifts).not.toContain('manual');
    });

    it('skips agents of a task a user paused', async () => {
      agents = [pausedAgent(taskId, new Date()), pausedAgent(null)];
      const result = await service.resumeCompany(companyId);
      expect(result.resumed).toBe(1);
    });

    it('exempts affected tasks only while a cap is reached', async () => {
      await service.resumeCompany(companyId);
      expect(calls).not.toContain('exempt');

      caps.isAnyReached.mockResolvedValue(true);
      await service.resumeCompany(companyId);
      expect(taskUpdate).toHaveBeenCalledWith(taskId, {
        spendCapExempt: true,
      });
    });
  });

  it('exemptIfCapped exempts a task only while a cap is reached', async () => {
    await service.exemptIfCapped(taskId);
    expect(taskUpdate).not.toHaveBeenCalled();

    caps.isAnyReached.mockResolvedValue(true);
    await service.exemptIfCapped(taskId);
    expect(taskUpdate).toHaveBeenCalledWith(taskId, { spendCapExempt: true });
  });

  describe('sweep', () => {
    it('resumes only cap-paused agents, and only when a cap reset', async () => {
      await service.sweep();
      expect(calls).toEqual([]);

      caps.resetExpired.mockResolvedValue(['anthropic']);
      await service.sweep();
      expect(agentFind).toHaveBeenCalledWith({
        where: { status: AgentStatus.Paused, pauseReason: 'spend_cap' },
        relations: { assignment: { task: true } },
      });
      expect(calls).toHaveLength(2);
      expect(resumeOptions[0]).toEqual({ lifts: ['spend_cap'] });
    });

    it('skips agents of a task a user paused', async () => {
      agents = [pausedAgent(taskId, new Date())];
      caps.resetExpired.mockResolvedValue(['anthropic']);
      await service.sweep();
      expect(calls).toEqual([]);
    });

    it('resumes nothing while the system drains', async () => {
      caps.resetExpired.mockResolvedValue(['anthropic']);
      shutdown.begin(false);
      await service.sweep();
      expect(calls).toEqual([]);
    });
  });

  it('dismissCap lifts the cap, then resumes the cap-paused agents', async () => {
    await service.dismissCap('anthropic', 'until-reset');

    expect(caps.dismiss).toHaveBeenCalledWith('anthropic', 'until-reset');
    expect(calls).toHaveLength(2);
  });
});
