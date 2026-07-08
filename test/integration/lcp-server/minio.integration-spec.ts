import * as https from 'https';
import * as http from 'http';
import { requireEnv } from '../../support/require-env';

// MinIO is provisioned by the integration global setup; MINIO_ENDPOINT is
// always present. Run via: ./scripts/run-integration-tests.sh
describe('MinIO connectivity', () => {
  it('health endpoint returns 200', async () => {
    const endpoint = requireEnv('MINIO_ENDPOINT');
    const healthUrl = `${endpoint}/minio/health/live`;
    const status = await new Promise<number>((resolve, reject) => {
      const mod = healthUrl.startsWith('https') ? https : http;
      mod
        .get(healthUrl, (res) => resolve(res.statusCode ?? 0))
        .on('error', reject);
    });
    expect(status).toBe(200);
  });
});
