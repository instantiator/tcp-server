import {
  AgentStatus,
  ProcessRestarter,
  TcpAgent,
  TcpAssignment,
  TcpTask,
} from '@tcp/shared';
import { ConflictException } from '@nestjs/common';
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
  let create: jest.Mock;
  let update: jest.Mock;
  let restart: jest.Mock;

  /** A drain over `running`, with restart supported or not. */
  const build = (running: TcpAgent[], restartSupported = false) =>
    new SystemDrainService(
      {
        find: () => Promise.resolve(running),
        update,
        count: () => Promise.resolve(0),
      } as unknown as Repository<TcpAgent>,
      {
        get: (key: string) =>
          key === 'TCP_RESTART_SUPPORTED' ? restartSupported : undefined,
      } as unknown as ConfigService,
      { record: jest.fn() } as unknown as AuditService,
      new SystemShutdownService(),
      { create } as unknown as NotificationService,
      { restart } as unknown as ProcessRestarter,
    );

  beforeEach(() => {
    create = jest.fn().mockResolvedValue(null);
    update = jest.fn().mockResolvedValue({ affected: 1 });
    restart = jest.fn();
  });

  // Nothing resumes a shutdown pause by itself, so the company must hear of it.
  it('raises one shutdown notice per paused task', async () => {
    await build([runningOn('a1', task), runningOn('a2', task)]).begin(false);

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

  describe('restart', () => {
    it('is refused where nothing would start the services again', async () => {
      await expect(build([]).begin(false, true)).rejects.toThrow(
        ConflictException,
      );
      expect(restart).not.toHaveBeenCalled();
    });

    it('pauses running agents for a restart, and says the task carries on by itself', async () => {
      const status = await build([runningOn('a1', task)], true).begin(
        false,
        true,
      );

      expect(update).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({
          status: AgentStatus.Paused,
          pauseReason: 'restart',
        }),
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          severity: 'info',
          message:
            'Task 003 was paused for a restart. It carries on by itself once the system is back.',
        }),
      );
      // Still waiting on the worker to confirm the agent stopped.
      expect(status).toMatchObject({ state: 'draining', restart: true });
      expect(restart).not.toHaveBeenCalled();
    });

    it('restarts the services once, the moment the drain quiesces', async () => {
      const drain = build([], true);

      const status = await drain.begin(false, true);
      await drain.status();
      await Promise.resolve();

      expect(status).toMatchObject({ state: 'quiesced', restart: true });
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it('never restarts at the end of a plain shutdown', async () => {
      const status = await build([], true).begin(false);
      await Promise.resolve();

      expect(status).toMatchObject({
        state: 'quiesced',
        restart: false,
        restartSupported: true,
      });
      expect(restart).not.toHaveBeenCalled();
    });
  });
});
