import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentLoopService } from '../agent/agent-loop.service';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { AgentWorkerService } from './agent-worker.service';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('AgentWorkerService', () => {
  let module: TestingModule;
  let registry: AgentRegistryService;
  let loopRun: jest.Mock;
  let processor: (job: {
    data: { agentId: string; type: string };
  }) => Promise<void>;

  beforeAll(async () => {
    loopRun = jest.fn().mockResolvedValue(undefined);

    module = await Test.createTestingModule({
      providers: [
        AgentWorkerService,
        AgentRegistryService,
        { provide: AgentLoopService, useValue: { run: loopRun } },
        {
          provide: ConfigService,
          useValue: { getOrThrow: () => 'redis://localhost:6379' },
        },
      ],
    }).compile();

    await module.init();

    registry = module.get(AgentRegistryService);

    const { Worker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq');
    const calls = Worker.mock.calls as Array<
      [string, typeof processor, unknown]
    >;
    processor = calls[0][1];
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(() => {
    loopRun.mockClear();
  });

  it('calls loop.run when the agent is not already running', async () => {
    await processor({ data: { agentId: 'agent-a', type: 'start' } });

    expect(loopRun).toHaveBeenCalledWith('agent-a');
  });

  it('skips loop.run when the agent is already running', async () => {
    const agentId = 'agent-b';
    registry.register(agentId, new AbortController());

    await processor({ data: { agentId, type: 'start' } });

    expect(loopRun).not.toHaveBeenCalled();

    registry.deregister(agentId);
  });
});
