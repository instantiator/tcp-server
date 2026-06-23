import { createClient } from 'redis';

// Requires REDIS_URL pointing to a running Redis instance.
// Run via: ./scripts/run-integration-tests.sh
describe('Redis connectivity', () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.REDIS_URL;
    if (!url) return;
    client = createClient({ url });
    await client.connect();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
  });

  it('responds to PING', async () => {
    if (!client?.isOpen) {
      console.log('Skipping — no REDIS_URL set');
      return;
    }
    const result = await client.ping();
    expect(result).toBe('PONG');
  });
});
