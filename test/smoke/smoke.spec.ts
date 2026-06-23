import * as http from 'http';

// Requires all services to be running (docker compose --profile auth up).
// Run via: ./scripts/run-smoke-tests.sh
// For remote deployments: ./scripts/run-smoke-tests.sh --base-url http://your-host:3000

const LCP_SERVER = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
const LCP_AGENT = process.env.LCP_AGENT_URL ?? 'http://localhost:3001';
/**
 * Full OIDC discovery URL. Defaults to Keycloak's master realm on localhost.
 * Override with OIDC_DISCOVERY_URL for non-Keycloak providers or remote deployments.
 */
const OIDC_DISCOVERY =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/realms/master/.well-known/openid-configuration';

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
  describe('oidc provider', () => {
    it('OIDC discovery endpoint returns 200', async () => {
      const res = await get(OIDC_DISCOVERY);
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
