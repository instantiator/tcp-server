import * as http from 'http';

// Requires all services to be running (docker compose --profile auth up).
// Run via: ./scripts/run-smoke-tests.sh
// For remote deployments: ./scripts/run-smoke-tests.sh --base-url http://your-host:3000

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

describe('Smoke', () => {
  describe('keycloak', () => {
    it('master realm OIDC discovery returns 200', async () => {
      // NB. /health/ready is on the management port (9000) in Keycloak 24+.
      // The master realm discovery URL is always served on port 8080.
      const res = await get(
        `${KEYCLOAK}/realms/master/.well-known/openid-configuration`,
      );
      expect(res.status).toBe(200);
    });
  });
  describe('lcp-server', () => {
    it('/health returns 200', async () => {
      const res = await get(`${LCP_SERVER}/health`);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-agent', () => {
    it('lcp-agent /health returns 200', async () => {
      const res = await get(`${LCP_AGENT}/health`);
      expect(res.status).toBe(200);
    });
  });
});
