import { ConfigService } from '@nestjs/config';
import { firstValueFrom, take } from 'rxjs';
import { KeyedEventBus } from './keyed-event-bus';

interface TestEvent {
  kind: string;
  value: number;
}

const channelFor = (key: string): string => `test:events:${key}`;

const mockSubscribe = jest.fn().mockResolvedValue(1);
const mockUnsubscribe = jest.fn().mockResolvedValue(1);
const mockPublish = jest.fn().mockResolvedValue(1);
const mockQuit = jest.fn().mockResolvedValue('OK');
let messageHandler: ((channel: string, message: string) => void) | undefined;
const mockOn = jest.fn(
  (event: string, handler: (channel: string, message: string) => void) => {
    if (event === 'message') messageHandler = handler;
  },
);

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    publish: mockPublish,
    quit: mockQuit,
    on: mockOn,
  })),
}));

function configWith(redisUrl: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'REDIS_URL' ? redisUrl : undefined)),
  } as unknown as ConfigService;
}

describe('KeyedEventBus', () => {
  describe('in-memory (no Redis configured)', () => {
    let bus: KeyedEventBus<TestEvent>;

    beforeEach(() => {
      jest.clearAllMocks();
      messageHandler = undefined;
      bus = new KeyedEventBus(
        configWith(undefined),
        channelFor,
        channelFor(''),
        'test',
      );
    });

    afterEach(async () => {
      await bus.onModuleDestroy();
    });

    it('delivers an emitted event directly to a local subscriber', async () => {
      const event: TestEvent = { kind: 'x', value: 1 };
      const received$ = bus.observe('key-1').pipe(take(1));
      const resultPromise = firstValueFrom(received$);

      bus.emit('key-1', event);

      expect(await resultPromise).toEqual(event);
    });

    it('is a no-op when emitting to a key with no subscribers', () => {
      expect(() => bus.emit('unknown', { kind: 'x', value: 1 })).not.toThrow();
    });

    it('never opens a Redis connection', () => {
      bus.observe('key-2').subscribe();
      bus.emit('key-2', { kind: 'x', value: 1 });
      expect(mockSubscribe).not.toHaveBeenCalled();
      expect(mockPublish).not.toHaveBeenCalled();
    });
  });

  describe('Redis relay', () => {
    let bus: KeyedEventBus<TestEvent>;

    beforeEach(() => {
      jest.clearAllMocks();
      messageHandler = undefined;
      bus = new KeyedEventBus(
        configWith('redis://localhost:6379'),
        channelFor,
        channelFor(''),
        'test',
      );
    });

    afterEach(async () => {
      await bus.onModuleDestroy();
    });

    it('subscribes the channel when the first observer attaches', () => {
      const sub = bus.observe('key-3').subscribe();
      expect(mockSubscribe).toHaveBeenCalledWith(channelFor('key-3'));
      sub.unsubscribe();
    });

    it('subscribes only once for multiple observers of the same key, and unsubscribes only after the last releases', () => {
      const a = bus.observe('key-4').subscribe();
      const b = bus.observe('key-4').subscribe();
      expect(mockSubscribe).toHaveBeenCalledTimes(1);
      expect(mockUnsubscribe).not.toHaveBeenCalled();

      a.unsubscribe();
      expect(mockUnsubscribe).not.toHaveBeenCalled();
      b.unsubscribe();
      expect(mockUnsubscribe).toHaveBeenCalledWith(channelFor('key-4'));
    });

    it('emit publishes to the channel rather than pushing directly', () => {
      const sub = bus.observe('key-5').subscribe();
      bus.emit('key-5', { kind: 'x', value: 1 });
      expect(mockPublish).toHaveBeenCalledWith(
        channelFor('key-5'),
        JSON.stringify({ kind: 'x', value: 1 }),
      );
      sub.unsubscribe();
    });

    it('delivers a published event back to the local subscriber via the relay (no double-delivery)', () => {
      const event: TestEvent = { kind: 'x', value: 1 };
      const received: TestEvent[] = [];
      const sub = bus.observe('key-6').subscribe((e) => received.push(e));

      bus.emit('key-6', event);
      // The relay fires from the mocked 'message' handler synchronously here.
      messageHandler?.(channelFor('key-6'), JSON.stringify(event));

      expect(received).toEqual([event]);
      sub.unsubscribe();
    });

    it('ignores malformed relayed messages', () => {
      let received = 0;
      const sub = bus.observe('key-7').subscribe(() => received++);
      expect(() =>
        messageHandler?.(channelFor('key-7'), 'not json'),
      ).not.toThrow();
      expect(received).toBe(0);
      sub.unsubscribe();
    });

    it('ignores a relayed message for a different channel prefix', () => {
      let received = 0;
      const sub = bus.observe('key-8').subscribe(() => received++);
      messageHandler?.(
        'other:events:key-8',
        JSON.stringify({ kind: 'x', value: 1 }),
      );
      expect(received).toBe(0);
      sub.unsubscribe();
    });
  });

  describe('onModuleDestroy', () => {
    it('completes open subjects and closes both Redis connections', async () => {
      const bus = new KeyedEventBus(
        configWith('redis://localhost:6379'),
        channelFor,
        channelFor(''),
        'test',
      );
      let completed = false;
      const sub = bus.observe('key-9').subscribe({
        complete: () => (completed = true),
      });
      bus.emit('key-9', { kind: 'x', value: 1 });

      await bus.onModuleDestroy();

      expect(completed).toBe(true);
      expect(mockQuit).toHaveBeenCalled();
      sub.unsubscribe();
    });
  });
});
