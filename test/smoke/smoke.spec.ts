import * as http from 'http';

// Requires all services to be running (docker compose --profile auth up).
// Run via: ./scripts/run-smoke-tests.sh
// For remote deployments: ./scripts/run-smoke-tests.sh --base-url http://your-host:3000

const LCP_SERVER = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
const LCP_AGENT = process.env.LCP_AGENT_URL ?? 'http://localhost:3001';
const LCP_MCP_STORAGE =
  process.env.LCP_MCP_STORAGE_URL ?? 'http://localhost:3010';
const LCP_MCP_MEMORY =
  process.env.LCP_MCP_MEMORY_URL ?? 'http://localhost:3011';
const LCP_MCP_INTERACTIONS =
  process.env.LCP_MCP_INTERACTIONS_URL ?? 'http://localhost:3012';
const LCP_MCP_TASKS = process.env.LCP_MCP_TASKS_URL ?? 'http://localhost:3013';
/**
 * Full OIDC discovery URL. Defaults to Zitadel on localhost.
 * Override with OIDC_DISCOVERY_URL for remote deployments.
 */
const OIDC_DISCOVERY =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';

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

/** Parse body and assert the terminus `status` field is `"ok"`. */
function expectHealthy(body: string): void {
  const parsed = JSON.parse(body) as { status?: string };
  expect(parsed.status).toBe('ok');
}

describe('Smoke', () => {
  describe('oidc provider', () => {
    it('OIDC discovery endpoint returns 200', async () => {
      const res = await get(OIDC_DISCOVERY);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-server', () => {
    it('/health returns 200 with status ok', async () => {
      const res = await get(`${LCP_SERVER}/health`);
      expect(res.status).toBe(200);
      expectHealthy(res.body);
    });

    it('/swagger returns 200', async () => {
      const res = await get(`${LCP_SERVER}/swagger`);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-agent', () => {
    it('/health returns 200 with status ok', async () => {
      const res = await get(`${LCP_AGENT}/health`);
      expect(res.status).toBe(200);
      expectHealthy(res.body);
    });

    it('/swagger returns 200', async () => {
      const res = await get(`${LCP_AGENT}/swagger`);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-mcp-storage', () => {
    it('/health returns 200 with status ok', async () => {
      const res = await get(`${LCP_MCP_STORAGE}/health`);
      expect(res.status).toBe(200);
      expectHealthy(res.body);
    });

    it('/swagger returns 200', async () => {
      const res = await get(`${LCP_MCP_STORAGE}/swagger`);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-mcp-memory', () => {
    it('/health returns 200 with status ok (PostgreSQL reachable)', async () => {
      const res = await get(`${LCP_MCP_MEMORY}/health`);
      expect(res.status).toBe(200);
      expectHealthy(res.body);
    });

    it('/swagger returns 200', async () => {
      const res = await get(`${LCP_MCP_MEMORY}/swagger`);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-mcp-interactions', () => {
    it('/health returns 200 with status ok', async () => {
      const res = await get(`${LCP_MCP_INTERACTIONS}/health`);
      expect(res.status).toBe(200);
      expectHealthy(res.body);
    });

    it('/swagger returns 200', async () => {
      const res = await get(`${LCP_MCP_INTERACTIONS}/swagger`);
      expect(res.status).toBe(200);
    });
  });

  describe('lcp-mcp-tasks', () => {
    it('/health returns 200 with status ok', async () => {
      const res = await get(`${LCP_MCP_TASKS}/health`);
      expect(res.status).toBe(200);
      expectHealthy(res.body);
    });

    it('/swagger returns 200', async () => {
      const res = await get(`${LCP_MCP_TASKS}/swagger`);
      expect(res.status).toBe(200);
    });
  });
});
