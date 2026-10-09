import { AuditClientService, runFailure, TcpAgent, TcpRole } from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { AgentRunStatusService } from './run-status.service';

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
      expect.stringContaining('The model returned nothing'),
    );
  });
});
