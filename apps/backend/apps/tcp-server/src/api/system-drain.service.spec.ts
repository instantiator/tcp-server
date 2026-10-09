import { AgentStatus, TcpAgent, TcpAssignment, TcpTask } from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notification.service';
import { SystemDrainService } from './system-drain.service';
import { SystemShutdownService } from './system-shutdown.service';

/** A running agent working `task`. */
const runningOn = (id: string, task: TcpTask): TcpAgent =>
  Object.assign(new TcpAgent(), {
    id,
    companyId: task.companyId,
    status: AgentStatus.Running,
    assignment: Object.assign(new TcpAssignment(), { taskId: task.id, task }),
  });

describe('SystemDrainService', () => {
  const task = Object.assign(new TcpTask(), {
    id: 'task-1',
    companyId: 'company-1',
    shortcode: '003',
  });

  // Nothing resumes a shutdown pause by itself, so the company must hear of it.
  it('raises one shutdown notice per paused task', async () => {
    const create = jest.fn().mockResolvedValue(null);
    const service = new SystemDrainService(
      {
        find: () =>
          Promise.resolve([runningOn('a1', task), runningOn('a2', task)]),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        count: () => Promise.resolve(0),
      } as unknown as Repository<TcpAgent>,
      { get: () => undefined } as unknown as ConfigService,
      { record: jest.fn() } as unknown as AuditService,
      new SystemShutdownService(),
      { create } as unknown as NotificationService,
    );

    await service.begin(false);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'task_paused',
        severity: 'warning',
        message: 'Task 003 was paused by a shutdown. Resume it to continue.',
        companyId: 'company-1',
        taskId: 'task-1',
      }),
    );
  });
});
