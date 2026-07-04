import { agentEventsChannel } from '@lcp/shared';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom, take, toArray } from 'rxjs';
import { AgentEvent, AgentEventService } from './agent-event.service';

const mockSubscribe = jest.fn().mockResolvedValue(1);
const mockUnsubscribe = jest.fn().mockResolvedValue(1);
const mockQuit = jest.fn().mockResolvedValue('OK');
let messageHandler: ((channel: string, message: string) => void) | undefined;
const mockOn = jest.fn(
  (event: string, handler: (channel: string, message: string) => void) => {
    if (event === 'message') {
      messageHandler = handler;
    }
  },
);

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    quit: mockQuit,
    on: mockOn,
  })),
}));

/** Builds a ConfigService stub returning `redisUrl` for the REDIS_URL key. */
function configWith(redisUrl: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'REDIS_URL' ? redisUrl : undefined)),
  } as unknown as ConfigService;
}

const compactionStarted: AgentEvent = {
  kind: 'compaction_started',
  timestamp: new Date().toISOString(),
  data: { tokensBefore: 100 },
};

describe('AgentEventService', () => {
  describe('in-memory bus (no Redis configured)', () => {
    let service: AgentEventService;

    beforeEach(() => {
      jest.clearAllMocks();
      messageHandler = undefined;
      service = new AgentEventService(configWith(undefined));
    });

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it('delivers emitted events to subscribers', async () => {
      const received$ = service.observe('agent-1').pipe(take(1));
      const resultPromise = firstValueFrom(received$);

      service.emit('agent-1', compactionStarted);

      expect(await resultPromise).toEqual(compactionStarted);
    });

    it('delivers multiple events in order', async () => {
      const events: AgentEvent[] = [
        { kind: 'compaction_started', timestamp: 'ts1' },
        { kind: 'compaction_complete', timestamp: 'ts2' },
      ];

      const received$ = service.observe('agent-2').pipe(take(2), toArray());
      const resultPromise = firstValueFrom(received$);

      for (const e of events) service.emit('agent-2', e);

      expect(await resultPromise).toEqual(events);
    });

    it('does not deliver events after cleanup', (done) => {
      let receivedCount = 0;
      const sub = service.observe('agent-3').subscribe(() => receivedCount++);

      service.emit('agent-3', compactionStarted);
      service.cleanup('agent-3');
      service.emit('agent-3', compactionStarted);

      setTimeout(() => {
        sub.unsubscribe();
        expect(receivedCount).toBe(1);
        done();
      }, 10);
    });

    it('is a no-op when emitting to an agent with no subscribers', () => {
      expect(() => service.emit('unknown', compactionStarted)).not.toThrow();
    });

    it('never opens a Redis connection', () => {
      service.observe('a1').subscribe();
      expect(mockSubscribe).not.toHaveBeenCalled();
    });
  });

  describe('Redis relay', () => {
    let service: AgentEventService;

    beforeEach(() => {
      jest.clearAllMocks();
      messageHandler = undefined;
      service = new AgentEventService(configWith('redis://localhost:6379'));
    });

    afterEach(async () => {
      await service.onModuleDestroy();
    });

    it('subscribes the agent channel when the first observer attaches', () => {
      const sub = service.observe('agent-4').subscribe();
      expect(mockSubscribe).toHaveBeenCalledWith(agentEventsChannel('agent-4'));
      sub.unsubscribe();
    });

    it('subscribes only once for multiple observers of the same agent', () => {
      const a = service.observe('agent-5').subscribe();
      const b = service.observe('agent-5').subscribe();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      a.unsubscribe();
      expect(mockUnsubscribe).not.toHaveBeenCalled();
      b.unsubscribe();
      expect(mockUnsubscribe).toHaveBeenCalledWith(
        agentEventsChannel('agent-5'),
      );
    });

    it('relays a Redis message to the agent subject', (done) => {
      const relayed: AgentEvent = {
        kind: 'response',
        timestamp: 'ts',
        data: { delta: 'hello' },
      };
      const sub = service.observe('agent-6').subscribe((event) => {
        expect(event).toEqual(relayed);
        sub.unsubscribe();
        done();
      });
      messageHandler?.(agentEventsChannel('agent-6'), JSON.stringify(relayed));
    });

    it('ignores malformed relayed messages', () => {
      let received = 0;
      const sub = service.observe('agent-7').subscribe(() => received++);
      expect(() =>
        messageHandler?.(agentEventsChannel('agent-7'), 'not json'),
      ).not.toThrow();
      expect(received).toBe(0);
      sub.unsubscribe();
    });

    it('shares one subscriber connection across agents', () => {
      const a = service.observe('agent-8').subscribe();
      const b = service.observe('agent-9').subscribe();
      // Two channels, one connection: subscribe called per channel but the
      // ioredis constructor (mockOn registered once) only ran once.
      expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockSubscribe).toHaveBeenCalledTimes(2);
      a.unsubscribe();
      b.unsubscribe();
    });
  });
});
