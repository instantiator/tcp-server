import { createClient } from 'redis';
import { requireEnv } from '../../support/require-env';

// Redis is provisioned by the integration global setup; REDIS_URL is always
// present. Run via: ./scripts/run-integration-tests.sh
describe('tcp-agent: Redis connectivity', () => {
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    client = createClient({ url: requireEnv('REDIS_URL') });
    await client.connect();
  });

  afterAll(async () => {
    if (client?.isOpen) {
      await client.quit();
    }
  });

  it('responds to PING', async () => {
    const result = await client.ping();
    expect(result).toBe('PONG');
  });
});
