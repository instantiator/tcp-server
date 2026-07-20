import { agentEventsChannel, StreamDelta } from '@lcp/shared';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID, UUID } from 'crypto';
import Redis from 'ioredis';
import { AgentEventPublisherService } from './agent-event-publisher.service';

const mockPublish = jest.fn().mockResolvedValue(1);
const mockQuit = jest.fn().mockResolvedValue('OK');
const mockOn = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    publish: mockPublish,
    quit: mockQuit,
    on: mockOn,
  })),
}));

/** The mocked ioredis constructor, for asserting connection creation. */
const mockRedisCtor = Redis as unknown as jest.Mock;

/** Builds a ConfigService stub returning `redisUrl` for the REDIS_URL key. */
function configWith(redisUrl: string | undefined): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'REDIS_URL' ? redisUrl : undefined)),
  } as unknown as ConfigService;
}

describe('AgentEventPublisherService', () => {
  let agentId: UUID;
  let sampleDelta: StreamDelta;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    agentId = randomUUID();
    sampleDelta = {
      type: 'stream',
      agentId,
      channel: 'response',
      delta: 'hello',
      timestamp: '2026-07-02T00:00:00.000Z',
    };
  });

  it('publishes the JSON-encoded delta to the agent channel', () => {
    const service = new AgentEventPublisherService(
      configWith('redis://localhost:6379'),
    );

    service.publish(sampleDelta);

    expect(mockPublish).toHaveBeenCalledWith(
      agentEventsChannel(agentId),
      JSON.stringify(sampleDelta),
    );
  });

  it('is a no-op when REDIS_URL is not configured', () => {
    const service = new AgentEventPublisherService(configWith(undefined));

    service.publish(sampleDelta);

    expect(mockRedisCtor).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('reuses a single connection across publishes', () => {
    const service = new AgentEventPublisherService(
      configWith('redis://localhost:6379'),
    );

    service.publish(sampleDelta);
    service.publish(sampleDelta);

    expect(mockRedisCtor).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledTimes(2);
  });

  it('registers an error handler so a closed connection cannot crash the process', () => {
    const service = new AgentEventPublisherService(
      configWith('redis://localhost:6379'),
    );

    service.publish(sampleDelta);

    expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('swallows publish rejections', async () => {
    mockPublish.mockRejectedValueOnce(new Error('down'));
    const service = new AgentEventPublisherService(
      configWith('redis://localhost:6379'),
    );

    expect(() => service.publish(sampleDelta)).not.toThrow();
    // Let the swallowed rejection settle.
    await Promise.resolve();
  });

  it('quits the connection on module destroy', async () => {
    const service = new AgentEventPublisherService(
      configWith('redis://localhost:6379'),
    );
    service.publish(sampleDelta);

    await service.onModuleDestroy();

    expect(mockQuit).toHaveBeenCalledTimes(1);
  });
});
