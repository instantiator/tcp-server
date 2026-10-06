import { AgentStatus, TcpAgent, TcpTask } from '@tcp/shared';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID, type UUID } from 'crypto';
import { In, type Repository } from 'typeorm';
import { SpendCapService } from '../spend/spend-cap.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { SpendResumeService } from './spend-resume.service';
import { SystemShutdownService } from './system-shutdown.service';

describe('SpendResumeService', () => {
  const taskId = randomUUID();
  const companyId = randomUUID();
  /** Records the order of exemption writes and resumes. */
  let calls: string[];
  let agents: TcpAgent[];
  let caps: jest.Mocked<
    Pick<SpendCapService, 'resetExpired' | 'dismiss' | 'isAnyReached'>
  >;
  let agentFind: jest.Mock<Promise<TcpAgent[]>, [unknown]>;
  let taskUpdate: jest.Mock<Promise<void>, [unknown, Partial<TcpTask>]>;
  let shutdown: SystemShutdownService;
  let service: SpendResumeService;

  const pausedAgent = (taskOf: UUID | null): TcpAgent =>
    ({
      id: randomUUID(),
      companyId,
      status: AgentStatus.Paused,
      pauseReason: 'spend_cap',
      assignment: { taskId: taskOf },
    }) as TcpAgent;

  beforeEach(() => {
    calls = [];
    agents = [pausedAgent(taskId), pausedAgent(null)];
    caps = {
      resetExpired: jest.fn().mockResolvedValue([]),
      dismiss: jest.fn().mockResolvedValue({}),
      isAnyReached: jest.fn().mockResolvedValue(false),
    };
    agentFind = jest.fn((_options: unknown) => Promise.resolve(agents));
    taskUpdate = jest.fn((_where: unknown, _patch: Partial<TcpTask>) => {
      calls.push('exempt');
      return Promise.resolve();
    });
    shutdown = new SystemShutdownService();
    const orchestration = {
      resumeAgent: (id: UUID) => {
        calls.push(`resume:${id}`);
        return Promise.resolve({} as TcpAgent);
      },
    } as unknown as AgentOrchestrationService;
    service = new SpendResumeService(
      caps as unknown as SpendCapService,
      orchestration,
      shutdown,
      { find: agentFind } as unknown as Repository<TcpAgent>,
      {
        findOneBy: () => Promise.resolve({ id: taskId } as TcpTask),
        update: taskUpdate,
      } as unknown as Repository<TcpTask>,
    );
  });

  describe('resumeTask', () => {
    it('exempts the task before resuming its cap-, shutdown- and rate-limit-paused agents', async () => {
      const result = await service.resumeTask(taskId);

      expect(calls[0]).toBe('exempt');
      expect(taskUpdate).toHaveBeenCalledWith(taskId, { spendCapExempt: true });
      expect(agentFind).toHaveBeenCalledWith({
        where: {
          status: AgentStatus.Paused,
          pauseReason: In(['spend_cap', 'shutdown', 'rate_limited']),
          assignment: { taskId },
        },
      });
      expect(result.resumed).toBe(2);
    });

    it('404s for an unknown task', async () => {
      service = new SpendResumeService(
        caps as unknown as SpendCapService,
        {} as AgentOrchestrationService,
        shutdown,
        { find: agentFind } as unknown as Repository<TcpAgent>,
        {
          findOneBy: () => Promise.resolve(null),
        } as unknown as Repository<TcpTask>,
      );
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

  it("resumeCompany exempts every affected task, then resumes the company's paused agents", async () => {
    const result = await service.resumeCompany(companyId);

    expect(taskUpdate).toHaveBeenCalledWith(
      { id: In([taskId]) },
      { spendCapExempt: true },
    );
    expect(calls[0]).toBe('exempt');
    expect(result.resumed).toBe(2);
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
      });
      expect(calls).toHaveLength(2);
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
