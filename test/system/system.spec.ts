import * as http from 'http';

// Requires all services to be running (docker compose --profile auth up).
// Run via: ./scripts/run-system-tests.sh

const LCP_SERVER = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
const LCP_AGENT = process.env.LCP_AGENT_URL ?? 'http://localhost:3001';
const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('System health', () => {
  it('keycloak master realm OIDC discovery returns 200', async () => {
    // /health/ready moved to the management port (9000) in Keycloak 24+.
    // The master realm discovery URL is always present and served on port 8080.
    const res = await get(
      `${KEYCLOAK}/realms/master/.well-known/openid-configuration`,
    );
    expect(res.status).toBe(200);
  });

  it('lcp-server /health returns 200 (includes database, minio, and oidc checks)', async () => {
    const res = await get(`${LCP_SERVER}/health`);
    expect(res.status).toBe(200);
  });

  it('lcp-agent /health returns 200', async () => {
    const res = await get(`${LCP_AGENT}/health`);
    expect(res.status).toBe(200);
  });
});
