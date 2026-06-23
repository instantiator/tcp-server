import * as https from 'https';
import * as http from 'http';

// Requires MINIO_ENDPOINT pointing to a running MinIO instance.
// Run via: ./scripts/run-integration-tests.sh
describe('MinIO connectivity', () => {
  it('health endpoint returns 200', async () => {
    const endpoint = process.env.MINIO_ENDPOINT;
    if (!endpoint) {
      console.log('Skipping — no MINIO_ENDPOINT set');
      return;
    }
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
