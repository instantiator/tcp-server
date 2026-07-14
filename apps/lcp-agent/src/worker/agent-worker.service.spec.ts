import { DEFAULT_AGENT_WORKER_CONCURRENCY } from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AgentLoopService } from '../agent/agent-loop.service';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { AgentWorkerService } from './agent-worker.service';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
  })),
}));

// The startup Redis reachability probe would otherwise open a real connection;
// unit tests have no Redis, so stub it to resolve.
jest.mock('@lcp/shared', () => ({
  ...jest.requireActual<typeof import('@lcp/shared')>('@lcp/shared'),
  assertRedisReachable: jest.fn().mockResolvedValue(undefined),
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
          useValue: {
            getOrThrow: () => 'redis://localhost:6379',
            // AGENT_WORKER_CONCURRENCY unset → worker falls back to the default.
            get: () => undefined,
          },
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

  // Regression test for a BullMQ shutdown race: if the module is torn down
  // before the worker's Redis connection finishes its initial handshake,
  // BullMQ's close() can strip its listeners before that handshake promise
  // settles, and a late rejection then throws as an unhandled 'error' with
  // no listener left to catch it (crashed a fast-running e2e health check in
  // CI). onModuleInit must await waitUntilReady() so the connection has
  // already settled before this module is considered started (and therefore
  // before anything can call close() on it).
  it('awaits the connection becoming ready before completing module init', () => {
    const { Worker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq');
    const instance = Worker.mock.results[0].value as {
      waitUntilReady: jest.Mock;
    };
    expect(instance.waitUntilReady).toHaveBeenCalled();
  });

  it('falls back to the default worker concurrency when AGENT_WORKER_CONCURRENCY is unset', () => {
    const { Worker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq');
    const opts = (
      Worker.mock.calls as Array<[string, unknown, { concurrency?: number }]>
    )[0][2];
    expect(opts.concurrency).toBe(DEFAULT_AGENT_WORKER_CONCURRENCY);
  });

  it('calls loop.run when the agent is not already running', async () => {
    await processor({ data: { agentId: 'agent-a', type: 'start' } });

    expect(loopRun).toHaveBeenCalledWith(
      'agent-a',
      undefined,
      expect.any(AbortController),
    );
  });

  it('skips loop.run when the agent is already running', async () => {
    const agentId = 'agent-b';
    registry.register(agentId, new AbortController());

    await processor({ data: { agentId, type: 'start' } });

    expect(loopRun).not.toHaveBeenCalled();

    registry.deregister(agentId);
  });

  it('deregisters the agent once loop.run resolves', async () => {
    const agentId = 'agent-c';

    await processor({ data: { agentId, type: 'start' } });

    expect(registry.isRunning(agentId)).toBe(false);
  });

  it('deregisters the agent even when loop.run rejects', async () => {
    const agentId = 'agent-d';
    loopRun.mockRejectedValueOnce(new Error('boom'));

    await expect(
      processor({ data: { agentId, type: 'start' } }),
    ).rejects.toThrow('boom');

    expect(registry.isRunning(agentId)).toBe(false);
  });

  // Regression test for the TOCTOU race that let a stalled-job retry start a
  // second concurrent execution against the same agent: registration must
  // happen with no `await` between the `isRunning` check and `registry.register`,
  // so by the time `loop.run` is actually invoked the agent is already
  // registered — a duplicate job arriving at that point is correctly rejected.
  it('registers the agent atomically with the isRunning check — no gap where a duplicate could slip through', async () => {
    const agentId = 'agent-e';
    let sawRegisteredDuringRun = false;
    loopRun.mockImplementationOnce(() => {
      sawRegisteredDuringRun = registry.isRunning(agentId);
      return Promise.resolve();
    });

    await processor({ data: { agentId, type: 'start' } });

    expect(sawRegisteredDuringRun).toBe(true);
  });
});
