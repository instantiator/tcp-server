import {
  AuditClientService,
  type RunFailure,
  runFailure,
  TcpAgent,
  TcpRole,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import {
  AgentRunStatusService,
  FAILURE_REPORT_RETRY_MS,
  FailureUnreportedError,
} from './run-status.service';

/** Matches the {@link RunFailure} `notifyFailed` was given, by its message. */
function failureWith(message: unknown): RunFailure {
  return expect.objectContaining({ message }) as RunFailure;
}

describe('AgentRunStatusService.failRun', () => {
  const agent = Object.assign(new TcpAgent(), {
    id: 'agent-1',
    companyId: 'c1',
    role: Object.assign(new TcpRole(), { name: 'r' }),
  });

  // The reason must still reach tcp-server, which fails the task with it.
  it('still reports the failure when saving it fails, without throwing', async () => {
    const notifyFailed = jest.fn();
    const service = new AgentRunStatusService(
      { notifyFailed, record: jest.fn() } as unknown as AuditClientService,
      {
        findOneBy: () => Promise.reject(new Error('database is down')),
      } as unknown as Repository<TcpAgent>,
      {} as ConfigService,
    );

    await expect(
      service.failRun(agent, runFailure('no_output')),
    ).resolves.toBeUndefined();
    expect(notifyFailed).toHaveBeenCalledWith(
      'agent-1',
      failureWith(expect.stringContaining('The model returned nothing')),
    );
  });

  describe('when tcp-server cannot be told', () => {
    const totalWait = FAILURE_REPORT_RETRY_MS.reduce((a, b) => a + b, 0);

    /** A service whose agent row saves fine and whose report fails `failures` times. */
    function serviceFailingReports(failures: number) {
      const notifyFailed = jest.fn();
      for (let i = 0; i < failures; i++) {
        notifyFailed.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      }
      notifyFailed.mockResolvedValue(undefined);
      const service = new AgentRunStatusService(
        { notifyFailed, record: jest.fn() } as unknown as AuditClientService,
        {
          findOneBy: () => Promise.resolve(agent),
          update: () => Promise.resolve(undefined),
        } as unknown as Repository<TcpAgent>,
        { get: () => undefined } as unknown as ConfigService,
      );
      return { service, notifyFailed };
    }

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('retries, and is done once a retry gets through', async () => {
      const { service, notifyFailed } = serviceFailingReports(2);

      const done = service.failRun(agent, runFailure('no_output'));
      await jest.advanceTimersByTimeAsync(totalWait);

      await expect(done).resolves.toBeUndefined();
      expect(notifyFailed).toHaveBeenCalledTimes(3);
    });

    it('gives up after every retry with an error the worker halts on', async () => {
      const { service, notifyFailed } = serviceFailingReports(99);

      const done = service.failRun(agent, runFailure('no_output'));
      const outcome = expect(done).rejects.toBeInstanceOf(
        FailureUnreportedError,
      );
      await jest.advanceTimersByTimeAsync(totalWait);

      await outcome;
      expect(notifyFailed).toHaveBeenCalledTimes(
        FAILURE_REPORT_RETRY_MS.length + 1,
      );
    });
  });
});
