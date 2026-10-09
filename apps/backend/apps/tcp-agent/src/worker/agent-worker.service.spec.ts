import {
  AgentStatus,
  TcpAgent,
  TcpCompany,
  TcpRole,
  type LlmConfig,
} from '@tcp/shared';
import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentLoopService } from '../agent/agent-loop.service';
import { AgentRunStatusService } from '../agent/run-status.service';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { AgentWorkerService } from './agent-worker.service';
import { ModelSlotService } from './model-slot.service';
import { ShutdownListenerService } from './shutdown-listener.service';

jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
  })),
  Queue: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    close: jest.fn().mockResolvedValue(undefined),
  })),
  Job: { fromId: jest.fn() },
  DelayedError: class DelayedError extends Error {},
}));

// The startup Redis reachability probe would otherwise open a real connection;
// unit tests have no Redis, so stub it to resolve.
jest.mock('@tcp/shared', () => ({
  ...jest.requireActual<typeof import('@tcp/shared')>('@tcp/shared'),
  assertRedisReachable: jest.fn().mockResolvedValue(undefined),
}));

/** The slice of a BullMQ job the processor touches. */
interface FakeJob {
  id?: string;
  data: { agentId: string; type: string };
  moveToDelayed?: jest.Mock;
}

/** A local-model agent (LM Studio), so it counts against the local pool. */
function agentRow(id: string, status = AgentStatus.Idle): TcpAgent {
  const llmConfig: LlmConfig = { provider: 'lm-studio', model: 'qwen' };
  return Object.assign(new TcpAgent(), {
    id,
    status,
    companyId: 'c1',
    role: Object.assign(new TcpRole(), { name: 'analyst', llmConfig }),
    company: new TcpCompany(),
  });
}

/** A job for `agentId` whose deferral can be observed. */
function job(agentId: string): FakeJob {
  return {
    id: `job-${agentId}`,
    data: { agentId, type: 'start' },
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  };
}

describe('AgentWorkerService', () => {
  let module: TestingModule;
  let registry: AgentRegistryService;
  let loopRun: jest.Mock;
  let findOne: jest.Mock;
  let markQueued: jest.Mock;
  let processor: (job: FakeJob, token?: string) => Promise<void>;

  /** The worker's collaborators, with `get` standing in for the environment. */
  function providers(get: (key: string) => string | undefined): Provider[] {
    return [
      AgentWorkerService,
      AgentRegistryService,
      // Real instance: with REDIS_URL unset it stays inert, so binding the
      // worker and reporting a finished job are both no-ops here.
      ShutdownListenerService,
      // Real instance: MODEL_CONCURRENCY unset → the built-in pool defaults
      // (one local run at a time).
      ModelSlotService,
      { provide: AgentLoopService, useValue: { run: loopRun } },
      { provide: AgentRunStatusService, useValue: { markQueued } },
      { provide: getRepositoryToken(TcpAgent), useValue: { findOne } },
      {
        provide: ConfigService,
        useValue: { getOrThrow: () => 'redis://localhost:6379', get },
      },
    ];
  }

  beforeAll(async () => {
    loopRun = jest.fn().mockResolvedValue(undefined);
    findOne = jest.fn();
    markQueued = jest.fn().mockResolvedValue(undefined);

    module = await Test.createTestingModule({
      providers: providers(() => undefined),
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
    loopRun.mockReset().mockResolvedValue(undefined);
    markQueued.mockClear();
    findOne
      .mockReset()
      .mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(agentRow(where.id)),
      );
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

  it('leaves run limits to the model pools, not BullMQ concurrency', () => {
    const { Worker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq');
    const opts = (
      Worker.mock.calls as Array<[string, unknown, { concurrency?: number }]>
    )[0][2];
    // Room for far more than the default local pool (1) and remote pool (4).
    expect(opts.concurrency).toBeGreaterThan(4);
  });

  it('warns that a still-set AGENT_WORKER_CONCURRENCY is ignored', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const other = await Test.createTestingModule({
      // Only this key: any other (REDIS_URL) must stay unset, or the real
      // shutdown listener tries to connect.
      providers: providers((key) =>
        key === 'AGENT_WORKER_CONCURRENCY' ? '3' : undefined,
      ),
    }).compile();
    await other.init();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('AGENT_WORKER_CONCURRENCY is no longer used'),
    );
    warn.mockRestore();
    await other.close();
  });

  it('calls loop.run when the agent is not already running', async () => {
    await processor(job('agent-a'));

    expect(loopRun).toHaveBeenCalledWith(
      'agent-a',
      undefined,
      expect.any(AbortController),
    );
  });

  it('skips loop.run when the agent is already running', async () => {
    const agentId = 'agent-b';
    registry.register(agentId, new AbortController());

    await processor(job(agentId));

    expect(loopRun).not.toHaveBeenCalled();

    registry.deregister(agentId);
  });

  it('deregisters the agent once loop.run resolves', async () => {
    const agentId = 'agent-c';

    await processor(job(agentId));

    expect(registry.isRunning(agentId)).toBe(false);
  });

  it('deregisters the agent even when loop.run rejects', async () => {
    const agentId = 'agent-d';
    loopRun.mockRejectedValueOnce(new Error('boom'));

    await expect(processor(job(agentId))).rejects.toThrow('boom');

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

    await processor(job(agentId));

    expect(sawRegisteredDuringRun).toBe(true);
  });

  it.each([AgentStatus.Completed, AgentStatus.Cancelled])(
    'drops a stale job for an agent that is already %s',
    async (status) => {
      findOne.mockResolvedValueOnce(agentRow('agent-f', status));

      await processor(job('agent-f'));

      expect(loopRun).not.toHaveBeenCalled();
      expect(registry.isRunning('agent-f')).toBe(false);
    },
  );

  describe('when the local pool is full', () => {
    let finishFirst: () => void;
    let firstRun: Promise<void>;

    beforeEach(() => {
      // The first run holds the only local slot until the test lets it go.
      loopRun.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      );
      firstRun = processor(job('agent-g'));
    });

    afterEach(async () => {
      finishFirst();
      await firstRun;
    });

    it('defers the next job without running it, and shows its agent queued', async () => {
      const waiting = job('agent-h');
      const { DelayedError } = jest.requireMock<{
        DelayedError: new () => Error;
      }>('bullmq');

      await expect(processor(waiting, 'tok')).rejects.toBeInstanceOf(
        DelayedError,
      );

      expect(loopRun).toHaveBeenCalledTimes(1);
      expect(markQueued).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'agent-h' }),
      );
      expect(waiting.moveToDelayed).toHaveBeenCalledWith(
        expect.any(Number),
        'tok',
      );
      // Deferred, not running: a drain mustn't wait on it.
      expect(registry.isRunning('agent-h')).toBe(false);
    });

    it('promotes the waiting job as soon as the slot frees', async () => {
      const { Job } = jest.requireMock<{ Job: { fromId: jest.Mock } }>(
        'bullmq',
      );
      const promote = jest.fn().mockResolvedValue(undefined);
      Job.fromId.mockResolvedValue({ promote });
      await processor(job('agent-i')).catch(() => undefined);

      finishFirst();
      await firstRun;
      await new Promise((resolve) => setImmediate(resolve));

      expect(Job.fromId).toHaveBeenCalledWith(expect.anything(), 'job-agent-i');
      expect(promote).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('resolves when startup never created a worker, so teardown cannot mask the startup error', async () => {
      // `.compile()` without `.init()` — onModuleInit never ran, exactly as
      // when the Redis probe throws before the worker is assigned.
      const uninitialised = await Test.createTestingModule({
        providers: providers(() => undefined),
      }).compile();

      await expect(
        uninitialised.get(AgentWorkerService).onModuleDestroy(),
      ).resolves.toBeUndefined();
    });

    it('swallows a close that rejects against a dead connection', async () => {
      const { Worker } = jest.requireMock<{ Worker: jest.Mock }>('bullmq');
      const instance = Worker.mock.results[0].value as { close: jest.Mock };
      instance.close.mockRejectedValueOnce(new Error('Connection is closed'));

      await expect(
        module.get(AgentWorkerService).onModuleDestroy(),
      ).resolves.toBeUndefined();
    });
  });
});
