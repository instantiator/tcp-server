import * as http from 'http';

// Requires all services to be running (docker compose up).
// Run via: ./scripts/run-system-tests.sh

const LCP_SERVER = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
const LCP_AGENT = process.env.LCP_AGENT_URL ?? 'http://localhost:3001';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body }),
        );
      })
      .on('error', reject);
  });
}

describe('System health', () => {
  it('lcp-server /health returns 200', async () => {
    const res = await get(`${LCP_SERVER}/health`);
    expect(res.status).toBe(200);
  });

  it('lcp-agent /health returns 200', async () => {
    const res = await get(`${LCP_AGENT}/health`);
    expect(res.status).toBe(200);
  });
});
