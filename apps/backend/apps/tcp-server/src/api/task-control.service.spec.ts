import { AgentStatus, TcpAgent, TcpTask } from '@tcp/shared';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { In, IsNull, type Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { TaskControlService } from './task-control.service';
import { TaskStateService } from './task-state.service';

describe('TaskControlService', () => {
  const taskId = randomUUID();
  let taskRepo: {
    findOneBy: jest.Mock;
    existsBy: jest.Mock;
    update: jest.Mock;
    findOneByOrFail: jest.Mock;
  };
  let agentRepo: { find: jest.Mock; update: jest.Mock };
  let record: jest.Mock;
  let recordTaskState: jest.Mock;
  let service: TaskControlService;

  const agent = (): TcpAgent =>
    ({
      id: randomUUID(),
      companyId: randomUUID(),
      status: AgentStatus.Running,
      role: { name: 'Analyst' },
    }) as TcpAgent;

  beforeEach(() => {
    taskRepo = {
      findOneBy: jest
        .fn()
        .mockResolvedValue({ id: taskId, status: 'succeeded' }),
      existsBy: jest.fn().mockResolvedValue(true),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOneByOrFail: jest
        .fn()
        .mockResolvedValue({ id: taskId, status: 'in-progress' }),
    };
    agentRepo = {
      find: jest.fn().mockResolvedValue([agent(), agent()]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    record = jest.fn().mockResolvedValue(undefined);
    recordTaskState = jest.fn().mockResolvedValue(undefined);
    service = new TaskControlService(
      taskRepo as unknown as Repository<TcpTask>,
      agentRepo as unknown as Repository<TcpAgent>,
      { record } as unknown as AuditService,
      { recordTaskState } as unknown as TaskStateService,
    );
  });

  it('claims the pause only for a running task that is not already paused', async () => {
    await service.pause(taskId, 'Ada');

    expect(taskRepo.update).toHaveBeenCalledWith(
      {
        id: taskId,
        status: In(['planning', 'in-progress', 'finalising']),
        pausedAt: IsNull(),
      },
      expect.objectContaining({ pausedBy: 'Ada' }),
    );
  });

  it('pauses each working agent as manual, and records each one', async () => {
    await service.pause(taskId, 'Ada');

    expect(agentRepo.find).toHaveBeenCalledWith({
      where: {
        status: In([AgentStatus.Idle, AgentStatus.Queued, AgentStatus.Running]),
        assignment: { taskId },
      },
      relations: { role: true },
    });
    expect(agentRepo.update).toHaveBeenCalledTimes(2);
    expect(agentRepo.update).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: AgentStatus.Paused,
        pauseReason: 'manual',
      }),
    );
    expect(record).toHaveBeenCalledTimes(2);
    expect(recordTaskState).toHaveBeenCalledWith(
      expect.objectContaining({ id: taskId }),
      'in-progress',
      'paused by a user',
    );
  });

  it('records nothing for an agent that moved on before its pause landed', async () => {
    agentRepo.update.mockResolvedValue({ affected: 0 });

    await service.pause(taskId, 'Ada');

    expect(record).not.toHaveBeenCalled();
  });

  it("409s a task that isn't running or is already paused", async () => {
    taskRepo.update.mockResolvedValue({ affected: 0 });

    await expect(service.pause(taskId, 'Ada')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(agentRepo.update).not.toHaveBeenCalled();
  });

  it('404s an unknown task', async () => {
    taskRepo.existsBy.mockResolvedValue(false);

    await expect(service.pause(taskId, 'Ada')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  describe('closeVisualisation', () => {
    it("closes a finished task's room and records it", async () => {
      const task = await service.closeVisualisation(taskId);

      expect(task.visualisationClosedAt).toBeInstanceOf(Date);
      expect(taskRepo.update).toHaveBeenCalledWith(taskId, {
        visualisationClosedAt: task.visualisationClosedAt,
      });
      expect(recordTaskState).toHaveBeenCalledWith(
        task,
        'succeeded',
        'room closed',
      );
    });

    it('leaves an already-closed room as it is', async () => {
      const closedAt = new Date(0);
      taskRepo.findOneBy.mockResolvedValue({
        id: taskId,
        status: 'failed',
        visualisationClosedAt: closedAt,
      });

      const task = await service.closeVisualisation(taskId);

      expect(task.visualisationClosedAt).toBe(closedAt);
      expect(taskRepo.update).not.toHaveBeenCalled();
    });

    it('409s a task still going', async () => {
      taskRepo.findOneBy.mockResolvedValue({ id: taskId, status: 'planning' });
      await expect(service.closeVisualisation(taskId)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('404s an unknown task', async () => {
      taskRepo.findOneBy.mockResolvedValue(null);
      await expect(service.closeVisualisation(taskId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
