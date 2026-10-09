import {
  AgentStatus,
  AuditEvent,
  RUN_FAILURE_MESSAGES,
  TcpAgent,
  TcpAssignment,
  TcpTask,
} from '@tcp/shared';
import { ConflictException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { AgentOrchestrationService } from './agent-orchestration.service';
import { AgentRecoveryService } from './agent-recovery.service';
import type { PauseAndResumeService } from './pause-and-resume.service';
import type { TaskFailureService } from './task-failure.service';

/** An agent on an in-progress step of an in-progress task, unless overridden. */
const agentOf = (
  id: string,
  status: AgentStatus,
  taskStatus: TcpTask['status'] = 'in-progress',
  pauseReason: TcpAgent['pauseReason'] = null,
): TcpAgent =>
  Object.assign(new TcpAgent(), {
    id,
    companyId: 'company-1',
    status,
    pauseReason,
    role: { name: 'Writer' },
    assignment: Object.assign(new TcpAssignment(), {
      status: 'in-progress',
      task: Object.assign(new TcpTask(), { id: 'task-1', status: taskStatus }),
    }),
  });

describe('AgentRecoveryService', () => {
  let stranded: TcpAgent[];
  let restartPaused: TcpAgent[];
  let auditRows: AuditEvent[];
  let withJobs: jest.Mock<Promise<Set<string>>, []>;
  let update: jest.Mock;
  let resumeAgent: jest.Mock;
  let failAgent: jest.Mock;
  let handleAgentFailed: jest.Mock;
  let record: jest.Mock;
  let service: AgentRecoveryService;

  beforeEach(() => {
    stranded = [];
    restartPaused = [];
    auditRows = [];
    withJobs = jest.fn(() => Promise.resolve(new Set<string>()));
    update = jest.fn().mockResolvedValue({ affected: 1 });
    resumeAgent = jest.fn().mockResolvedValue(undefined);
    failAgent = jest.fn().mockResolvedValue(undefined);
    handleAgentFailed = jest.fn().mockResolvedValue(undefined);
    record = jest.fn().mockResolvedValue(undefined);
    service = new AgentRecoveryService(
      {
        // First call: running/queued candidates; second: restart pauses.
        find: ({ where }: { where: { status: unknown } }) =>
          Promise.resolve(
            where.status === AgentStatus.Paused ? restartPaused : stranded,
          ),
        update,
      } as unknown as Repository<TcpAgent>,
      {
        find: () => Promise.resolve(auditRows),
      } as unknown as Repository<AuditEvent>,
      {
        agentIdsWithJobs: withJobs,
        resumeAgent,
      } as unknown as AgentOrchestrationService,
      { failAgent } as unknown as PauseAndResumeService,
      { handleAgentFailed } as unknown as TaskFailureService,
      { record } as unknown as AuditService,
    );
  });

  it('pauses a stranded running agent for a restart, marking it recovered', async () => {
    stranded = [agentOf('a1', AgentStatus.Running)];

    await service.recover();

    expect(update).toHaveBeenCalledWith(
      { id: 'a1', status: AgentStatus.Running },
      expect.objectContaining({
        status: AgentStatus.Paused,
        pauseReason: 'restart',
      }),
    );
    expect(record).toHaveBeenCalledWith(
      'company-1',
      'Writer',
      'a1',
      expect.anything(),
      expect.objectContaining({ reason: 'restart', recovered: true }),
    );
    expect(failAgent).not.toHaveBeenCalled();
  });

  it('treats a stranded queued agent the same way', async () => {
    stranded = [agentOf('a1', AgentStatus.Queued)];

    await service.recover();

    expect(update).toHaveBeenCalledWith(
      { id: 'a1', status: AgentStatus.Queued },
      expect.objectContaining({ pauseReason: 'restart' }),
    );
  });

  it('leaves an agent that still has a job alone', async () => {
    stranded = [agentOf('a1', AgentStatus.Running)];
    withJobs.mockResolvedValue(new Set(['a1']));

    await service.recover();

    expect(update).not.toHaveBeenCalled();
  });

  it('touches nothing when the queue cannot be read', async () => {
    stranded = [agentOf('a1', AgentStatus.Running)];
    withJobs.mockRejectedValue(new Error('Connection is closed'));

    await service.recover();

    expect(update).not.toHaveBeenCalled();
    expect(failAgent).not.toHaveBeenCalled();
  });

  it('fails a stranded agent whose task has already ended, and runs its task path', async () => {
    stranded = [agentOf('a1', AgentStatus.Running, 'failed')];

    await service.recover();

    const reason = RUN_FAILURE_MESSAGES.interrupted({});
    expect(update).toHaveBeenCalledWith(
      { id: 'a1', status: AgentStatus.Running },
      { status: AgentStatus.Failed },
    );
    expect(failAgent).toHaveBeenCalledWith('a1', reason);
    expect(handleAgentFailed).toHaveBeenCalledWith('a1', reason);
  });

  // An agent that strands every time would otherwise be resumed on every boot.
  it('fails an agent stranded again after an earlier recovery', async () => {
    stranded = [agentOf('a1', AgentStatus.Running)];
    auditRows = [
      Object.assign(new AuditEvent(), {
        payload: { reason: 'restart', recovered: true },
      }),
    ];

    await service.recover();

    expect(failAgent).toHaveBeenCalledWith(
      'a1',
      RUN_FAILURE_MESSAGES.interrupted({}),
    );
  });

  it('skips an agent another writer moved first', async () => {
    stranded = [agentOf('a1', AgentStatus.Running, 'failed')];
    update.mockResolvedValue({ affected: 0 });

    await service.recover();

    expect(failAgent).not.toHaveBeenCalled();
  });

  it('resumes every agent paused for a restart, lifting only that reason', async () => {
    restartPaused = [
      agentOf('a1', AgentStatus.Paused, 'in-progress', 'restart'),
    ];

    await service.recover();

    expect(resumeAgent).toHaveBeenCalledWith('a1', undefined, {
      lifts: ['restart'],
    });
  });

  it('leaves a restart pause on a task a user paused, without stopping the rest', async () => {
    restartPaused = [
      agentOf('a1', AgentStatus.Paused, 'in-progress', 'restart'),
      agentOf('a2', AgentStatus.Paused, 'in-progress', 'restart'),
    ];
    resumeAgent.mockRejectedValueOnce(
      new ConflictException(
        'This task is paused. Resume the task to continue.',
      ),
    );

    await service.recover();

    expect(resumeAgent).toHaveBeenCalledTimes(2);
  });
});
