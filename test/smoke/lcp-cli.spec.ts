/**
 * System tests for the API surface exercised by lcp-cli.
 *
 * These tests confirm the full round-trip that each CLI verb performs:
 * the server must reach Keycloak internally (catching the ECONNREFUSED
 * regression), and all JWT-guarded endpoints must be reachable.
 *
 * Run via: ./scripts/run-system-tests.sh
 * Requires: docker compose --profile auth up, Keycloak lcp realm configured.
 */

const BASE = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
const USERNAME = process.env.TEST_USERNAME ?? 'test';
const PASSWORD = process.env.TEST_PASSWORD ?? 'test';

// Unique suffix so repeated runs don't collide on slug constraints.
const RUN_ID = Date.now().toString(36);

interface TokenBody {
  access_token: string;
  token_type: string;
}

interface Company {
  id: string;
  name: string;
  slug: string;
}

interface Role {
  id: string;
  name: string;
  companyId: string;
}

interface Agent {
  id: string;
  status: string;
}

async function api<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.status === 204 ? ({} as T) : ((await res.json()) as T);
  return { status: res.status, data };
}

describe('lcp-cli API flows', () => {
  let token: string;
  let companyId: string;
  let roleId: string;
  let agentId: string;

  // get-token: the server must reach Keycloak internally to exchange credentials.
  // This is the exact path that caused the ECONNREFUSED regression.
  describe('get-token (POST /api/auth/token)', () => {
    it('returns an access_token for valid credentials', async () => {
      const { status, data } = await api<TokenBody>(
        'POST',
        '/api/auth/token',
        undefined,
        { username: USERNAME, password: PASSWORD },
      );
      expect(status).toBe(200);
      expect(typeof data.access_token).toBe('string');
      expect(data.access_token.length).toBeGreaterThan(0);
      token = data.access_token;
    });

    it('returns 401 for invalid credentials', async () => {
      const { status } = await api<unknown>(
        'POST',
        '/api/auth/token',
        undefined,
        { username: USERNAME, password: 'wrong-password' },
      );
      expect(status).toBe(401);
    });
  });

  // All remaining tests need a valid token — skip the suite if get-token failed.
  beforeAll(async () => {
    if (!token) {
      const { data } = await api<TokenBody>(
        'POST',
        '/api/auth/token',
        undefined,
        { username: USERNAME, password: PASSWORD },
      );
      token = data.access_token;
    }
  });

  describe('set-company (POST /api/company)', () => {
    it('creates a new company', async () => {
      const { status, data } = await api<Company>(
        'POST',
        '/api/company',
        token,
        { name: `CLI Test Corp ${RUN_ID}`, slug: `cli-test-${RUN_ID}` },
      );
      expect(status).toBe(201);
      expect(typeof data.id).toBe('string');
      companyId = data.id;
    });

    it('updates the company via PUT', async () => {
      const { status, data } = await api<Company>(
        'PUT',
        `/api/company/${companyId}`,
        token,
        { id: companyId, name: `CLI Test Corp ${RUN_ID} (updated)`, slug: `cli-test-${RUN_ID}` },
      );
      expect(status).toBe(200);
      expect(data.name).toContain('updated');
    });
  });

  describe('list-companies (GET /api/company)', () => {
    it('returns an array that includes the created company', async () => {
      const { status, data } = await api<Company[]>('GET', '/api/company', token);
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.some((c) => c.id === companyId)).toBe(true);
    });
  });

  describe('set-role (POST /api/role)', () => {
    it('creates a new role under the company', async () => {
      const { status, data } = await api<Role>(
        'POST',
        '/api/role',
        token,
        {
          name: `cli-analyst-${RUN_ID}`,
          companyId,
          description: 'Integration test role',
          systemPromptTemplate: 'You are {{name}}.',
          knowledgeDomains: [],
          mcpServerList: [],
          llmConfig: { modelId: 'stub', apiKeyEnvVar: 'STUB_KEY' },
        },
      );
      expect(status).toBe(201);
      expect(data.companyId).toBe(companyId);
      roleId = data.id;
    });

    it('updates the role via PUT', async () => {
      const { status, data } = await api<Role>(
        'PUT',
        `/api/role/${roleId}`,
        token,
        { description: 'Updated description' },
      );
      expect(status).toBe(200);
      expect(data.id).toBe(roleId);
    });
  });

  describe('list-roles (GET /api/company/:id/roles)', () => {
    it('returns roles for the company', async () => {
      const { status, data } = await api<Role[]>(
        'GET',
        `/api/company/${companyId}/roles`,
        token,
      );
      expect(status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      expect(data.some((r) => r.id === roleId)).toBe(true);
    });
  });

  describe('chat (POST /api/agent/chat/start + DELETE /api/agent/:id)', () => {
    it('creates a chat agent', async () => {
      const { status, data } = await api<Agent>(
        'POST',
        '/api/agent/chat/start',
        token,
        { companyId, roleId },
      );
      expect(status).toBe(201);
      expect(data.status).toBe('idle');
      agentId = data.id;
    });

    it('deletes the chat agent', async () => {
      const { status } = await api<unknown>(
        'DELETE',
        `/api/agent/${agentId}`,
        token,
      );
      expect(status).toBe(204);
    });
  });
});
