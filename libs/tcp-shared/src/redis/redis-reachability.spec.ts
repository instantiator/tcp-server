import { assertRedisReachable } from './redis-reachability';

const connect = jest.fn();
const ping = jest.fn();
const destroy = jest.fn();
const on = jest.fn();

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({ connect, ping, destroy, on })),
}));

describe('assertRedisReachable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('resolves when the client connects and responds to ping', async () => {
    connect.mockResolvedValue(undefined);
    ping.mockResolvedValue('PONG');

    await expect(
      assertRedisReachable('redis://localhost:6379'),
    ).resolves.toBeUndefined();
    expect(destroy).toHaveBeenCalled();
  });

  it('throws an actionable error when the connection fails', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      assertRedisReachable('redis://localhost:6379'),
    ).rejects.toThrow(/Redis is not reachable/);
    expect(destroy).toHaveBeenCalled();
  });

  it('redacts any password from the error message', async () => {
    connect.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      assertRedisReachable('redis://:supersecret@localhost:6379'),
    ).rejects.not.toThrow(/supersecret/);
  });
});
