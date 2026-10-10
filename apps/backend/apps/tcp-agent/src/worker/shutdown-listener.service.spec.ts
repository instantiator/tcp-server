import {
  ProcessRestarter,
  SHUTDOWN_COMMAND_CHANNEL,
  SHUTDOWN_STATUS_CHANNEL,
  ShutdownAction,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import type { Worker } from 'bullmq';
import { AgentRegistryService } from '../registry/agent-registry.service';
import { ShutdownListenerService } from './shutdown-listener.service';

/** The subset of an ioredis client this service uses. */
interface FakeRedis {
  on: jest.Mock;
  subscribe: jest.Mock;
  publish: jest.Mock;
  quit: jest.Mock;
}

const clients: FakeRedis[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const client: FakeRedis = {
      on: jest.fn(),
      subscribe: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn().mockResolvedValue(1),
      quit: jest.fn().mockResolvedValue('OK'),
    };
    clients.push(client);
    return client;
  }),
}));

/** The subset of the BullMQ worker the listener drives. */
function makeWorker(): jest.Mocked<Pick<Worker, 'pause' | 'resume'>> {
  return {
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn(),
  };
}

describe('ShutdownListenerService', () => {
  let registry: AgentRegistryService;
  let service: ShutdownListenerService;
  let worker: ReturnType<typeof makeWorker>;
  let restart: jest.Mock;
  /** What `TCP_RESTART_SUPPORTED` reads as for this test. */
  let restartFlag: string | undefined;
  /** The 'message' handler the service registered on its subscriber. */
  let deliver: (channel: string, message: string) => void;

  /** Publishes one command to the service, as Redis would. */
  async function send(action: ShutdownAction): Promise<void> {
    deliver(SHUTDOWN_COMMAND_CHANNEL, JSON.stringify({ action }));
    // The handler is async; let its microtasks (pause, publish) settle.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  /** The last in-flight count the service reported to tcp-server. */
  function lastReport(): unknown {
    const publisher = clients[0];
    const calls = publisher.publish.mock.calls as [string, string][];
    const last = calls.at(-1);
    if (!last) return undefined;
    expect(last[0]).toBe(SHUTDOWN_STATUS_CHANNEL);
    return JSON.parse(last[1]) as unknown;
  }

  beforeEach(async () => {
    clients.length = 0;
    registry = new AgentRegistryService();
    restart = jest.fn();
    restartFlag = undefined;
    service = new ShutdownListenerService(
      {
        get: (key: string) =>
          key === 'TCP_RESTART_SUPPORTED'
            ? restartFlag
            : 'redis://localhost:6379',
      } as unknown as ConfigService,
      registry,
      { restart } as unknown as ProcessRestarter,
    );
    await service.onModuleInit();

    worker = makeWorker();
    service.bindWorker(worker as unknown as Worker);

    // clients[0] is the publisher, clients[1] the subscriber.
    const onCalls = clients[1].on.mock.calls as [
      string,
      (channel: string, message: string) => void,
    ][];
    const messageHandler = onCalls.find(([event]) => event === 'message');
    if (!messageHandler) throw new Error('no message handler registered');
    deliver = messageHandler[1];
  });

  it('subscribes to the command channel on init', () => {
    expect(clients[1].subscribe).toHaveBeenCalledWith(SHUTDOWN_COMMAND_CHANNEL);
  });

  describe('drain', () => {
    it('stops the worker taking new jobs and reports the in-flight count', async () => {
      registry.register('a', new AbortController());
      registry.register('b', new AbortController());

      await send('drain');

      expect(worker.pause).toHaveBeenCalledTimes(1);
      expect(lastReport()).toEqual({ activeAgents: 2 });
    });

    it('leaves in-flight runs alone, so their spent tokens are not wasted', async () => {
      const controller = new AbortController();
      registry.register('a', controller);

      await send('drain');

      expect(controller.signal.aborted).toBe(false);
    });

    it('reports zero immediately when nothing is running', async () => {
      await send('drain');
      expect(lastReport()).toEqual({ activeAgents: 0 });
    });
  });

  describe('force', () => {
    it('aborts every in-flight run', async () => {
      const first = new AbortController();
      const second = new AbortController();
      registry.register('a', first);
      registry.register('b', second);

      await send('force');

      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(true);
      expect(worker.pause).toHaveBeenCalledTimes(1);
    });

    it('still reports the loops as in flight until they finish unwinding', async () => {
      registry.register('a', new AbortController());

      await send('force');

      // Aborting asks the loop to stop; the loop deregisters itself once it
      // actually has, and reportActive is called again then.
      expect(lastReport()).toEqual({ activeAgents: 1 });
    });
  });

  describe('cancel', () => {
    it('lets the worker take jobs again and stops reporting', async () => {
      await send('drain');
      const before = clients[0].publish.mock.calls.length;

      await send('cancel');
      expect(worker.resume).toHaveBeenCalledTimes(1);

      // Outside a drain nobody is waiting on the count.
      service.reportActive();
      expect(clients[0].publish.mock.calls).toHaveLength(before);
    });
  });

  describe('restart', () => {
    it('exits so the supervisor starts a fresh process, when restart is supported', async () => {
      restartFlag = 'true';
      await send('drain');
      await send('restart');
      expect(restart).toHaveBeenCalledTimes(1);
      expect(worker.resume).not.toHaveBeenCalled();
    });

    it('takes jobs again instead of exiting when nothing would restart it', async () => {
      await send('drain');
      await send('restart');
      expect(restart).not.toHaveBeenCalled();
      expect(worker.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe('reportActive', () => {
    it('publishes nothing before a drain has begun', () => {
      service.reportActive();
      expect(clients[0].publish).not.toHaveBeenCalled();
    });

    it('publishes the current count while draining', async () => {
      await send('drain');
      registry.register('a', new AbortController());

      service.reportActive();
      expect(lastReport()).toEqual({ activeAgents: 1 });
    });
  });

  it('ignores a malformed command rather than crashing the worker process', async () => {
    deliver(SHUTDOWN_COMMAND_CHANNEL, 'not json');
    await Promise.resolve();
    expect(worker.pause).not.toHaveBeenCalled();
  });

  it('ignores traffic on other channels', async () => {
    deliver('some:other:channel', JSON.stringify({ action: 'force' }));
    await Promise.resolve();
    expect(worker.pause).not.toHaveBeenCalled();
  });

  it('closes both connections on destroy', async () => {
    await service.onModuleDestroy();
    expect(clients[0].quit).toHaveBeenCalled();
    expect(clients[1].quit).toHaveBeenCalled();
  });
});
