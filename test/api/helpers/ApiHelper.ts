import { randomUUID, UUID } from 'crypto';
import { DeepPartial } from 'typeorm';
import { TcpCompany, TcpRole } from '../../../libs/tcp-shared/src/models';

export const BASE = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
export const OIDC_DISCOVERY_URL =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';
/** Machine user (client_credentials) — see docker/zitadel-machinekey and start-deployment.sh. */
export const TEST_CLIENT_ID = process.env.TEST_CLIENT_ID ?? '';
export const TEST_CLIENT_SECRET = process.env.TEST_CLIENT_SECRET ?? '';

/** Unique suffix so repeated runs don't collide on slug constraints. */
export const RUN_ID = Date.now().toString(36);

export interface ApiInvocationParams<RequestType> {
  method: 'POST' | 'PUT' | 'GET' | 'DELETE';
  path: string;
  body?: DeepPartial<RequestType>;
  expectedStatus?: number;
  token?: string;
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenPollResponse {
  status?: string;
  access_token?: string;
}

interface ChatRequest {
  companyId: UUID;
  roleId: UUID;
}

export interface ChatResponse {
  id: UUID;
  status: string;
}

export interface DocumentSummary {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

export class ApiHelper {
  token: string;

  constructor(token: string) {
    this.token = token;
  }

  /** Starts a device authorization (`POST /api/auth/device`) — no credentials required. */
  static async startDeviceAuthorization() {
    const { data } = await this.invokeApi<
      undefined,
      DeviceAuthorizationResponse
    >({
      method: 'POST',
      path: '/api/auth/device',
      expectedStatus: 200,
    });
    return data!;
  }

  /** Polls once for the outcome of a device authorization (`POST /api/auth/device/token`). */
  static async pollDeviceToken(deviceCode: string) {
    const { data } = await this.invokeApi<
      { device_code: string },
      DeviceTokenPollResponse
    >({
      method: 'POST',
      path: '/api/auth/device/token',
      body: { device_code: deviceCode },
      expectedStatus: 200,
    });
    return data!;
  }

  /**
   * Obtains a token via the client_credentials grant against the OIDC
   * provider directly, using the machine test user created by
   * start-deployment.sh. Device-flow login requires a human in a browser, so
   * this is what the api test tier uses instead — there's no client secret
   * to protect here (it's a test-only credential), so no server-side proxy
   * is needed the way the human login flow needs one.
   */
  static async getMachineToken(
    clientSecret: string = TEST_CLIENT_SECRET,
    expectedStatus = 200,
  ): Promise<string | undefined> {
    const discoveryRes = await fetch(OIDC_DISCOVERY_URL);
    const { token_endpoint } = (await discoveryRes.json()) as {
      token_endpoint: string;
    };

    const res = await fetch(token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: TEST_CLIENT_ID,
        client_secret: clientSecret,
        scope: 'openid profile',
      }).toString(),
    });
    expect(res.status).toBe(expectedStatus);
    if (res.status !== 200) return undefined;

    const data = (await res.json()) as { access_token: string };
    expect(data.access_token).toBeDefined();
    expect(data.access_token.length).toBeGreaterThan(0);
    return data.access_token;
  }

  async listCompanies() {
    const { data } = await this.invokeApi<
      undefined,
      { id: UUID; name: string }[]
    >({
      method: 'GET',
      path: '/api/company',
      expectedStatus: 200,
    });
    expect(data).toBeDefined();
    expect(data).not.toBeNull();
    expect(Array.isArray(data)).toBe(true);
    return data!;
  }

  async listRoles(companyId: UUID) {
    const { data } = await this.invokeApi<undefined, TcpRole[]>({
      method: 'GET',
      path: `/api/company/${companyId}/roles`,
      expectedStatus: 200,
    });
    expect(data).toBeDefined();
    expect(data).not.toBeNull();
    expect(Array.isArray(data)).toBe(true);
    return data!;
  }

  async createTestCompany(name: string, slug: string) {
    const { data } = await this.invokeApi<TcpCompany, TcpCompany>({
      method: 'POST',
      path: '/api/company',
      body: {
        name,
        slug,
        description: 'createCompany',
      },
      expectedStatus: 201,
    });
    expect(data?.id).toBeDefined();
    expect(data!.id.length).toBeGreaterThan(0);
    return data!;
  }

  async updateCompany(id: UUID, changes: DeepPartial<TcpCompany>) {
    const { data } = await this.invokeApi<TcpCompany, TcpCompany>({
      method: 'PUT',
      path: `/api/company/${id}`,
      body: changes,
      expectedStatus: 200,
    });
    expect(data?.id).toEqual(id);
    return data!;
  }

  async createTestRole(name: string, companyId: UUID) {
    const { data } = await this.invokeApi<TcpRole, TcpRole>({
      method: 'POST',
      path: `/api/role`,
      body: {
        name,
        // Slugs are unique per company; callers may reuse the same `name`
        // across multiple roles in one test run, so derive a unique slug
        // per call rather than reusing `name` verbatim.
        slug: `${name}-${randomUUID().slice(0, 8)}`,
        companyId,
        description: 'Test role',
        systemPromptTemplate: 'You are {{name}}.',
        knowledgeDomains: [],
        mcpServerList: [],
        llmConfig: {
          model: 'stub',
          apiKey: 'stub-key',
          baseUrl: 'http://example.com',
          contextWindow: 4096,
          provider: 'lm-studio',
        },
      },
      expectedStatus: 201,
    });
    expect(data?.id).toBeDefined();
    expect(data!.id.length).toBeGreaterThan(0);
    expect(data!.companyId).toEqual(companyId);
    return data!;
  }

  async updateRole(id: UUID, changes: DeepPartial<TcpRole>) {
    const { data } = await this.invokeApi<TcpRole, TcpRole>({
      method: 'PUT',
      path: `/api/role/${id}`,
      body: changes,
      expectedStatus: 200,
    });
    expect(data?.id).toEqual(id);
    return data!;
  }

  async startAgentChat(companyId: UUID, roleId: UUID) {
    const response = await this.invokeApi<ChatRequest, ChatResponse>({
      method: 'POST',
      path: '/api/agent/chat/start',
      body: { companyId, roleId },
      expectedStatus: 201,
    });
    expect(response.data).toBeDefined();
    expect(response.data!.id).toBeDefined();
    expect(response.data!.id).not.toBeNull();
    expect(response.data!.id.length).toBeGreaterThan(0);
    return response.data!;
  }

  async deleteAgent(agentId: UUID) {
    await this.invokeApi<ChatRequest, ChatResponse>({
      method: 'DELETE',
      path: `/api/agent/${agentId}`,
      expectedStatus: 204,
    });
  }

  async listKnowledge(scopePath: string) {
    const { data } = await this.invokeApi<undefined, DocumentSummary[]>({
      method: 'GET',
      path: `/api/${scopePath}/knowledge`,
      expectedStatus: 200,
    });
    expect(Array.isArray(data)).toBe(true);
    return data!;
  }

  async deleteKnowledge(scopePath: string, filename: string) {
    await this.invokeApi({
      method: 'DELETE',
      path: `/api/${scopePath}/knowledge/${encodeURIComponent(filename)}`,
      expectedStatus: 204,
    });
  }

  /**
   * Uploads a knowledge document via `multipart/form-data`. Not routed
   * through {@link invokeApi} since that only sends JSON bodies. `content`
   * may be a `Buffer` for binary formats (`.pdf`/`.docx`); the multipart
   * content-type is always `application/octet-stream` since the server
   * dispatches conversion by filename extension, not this header.
   */
  async storeKnowledge(
    scopePath: string,
    filename: string,
    content: string | Buffer,
    expectedStatus = 201,
  ) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(Buffer.from(content))], {
        type: 'application/octet-stream',
      }),
      filename,
    );
    const res = await fetch(`${BASE}/api/${scopePath}/knowledge`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
    });
    expect(res.status).toBe(expectedStatus);
    return res.status === 201 ? ((await res.json()) as DocumentSummary) : null;
  }

  /**
   * Downloads a knowledge document's raw text content via `fetch` directly
   * (not routed through {@link invokeApi}, which always parses JSON).
   */
  async getKnowledgeText(
    scopePath: string,
    filename: string,
    expectedStatus = 200,
  ) {
    const res = await fetch(
      `${BASE}/api/${scopePath}/knowledge/${encodeURIComponent(filename)}`,
      { headers: { Authorization: `Bearer ${this.token}` } },
    );
    expect(res.status).toBe(expectedStatus);
    return res.status === 200 ? await res.text() : null;
  }

  private async invokeApi<RequestType, ResponseType>(
    props: ApiInvocationParams<RequestType>,
  ) {
    return await ApiHelper.invokeApi<RequestType, ResponseType>({
      ...props,
      token: this.token,
    });
  }

  private static async invokeApi<RequestType, ResponseType>({
    method,
    path,
    body,
    expectedStatus,
    token,
  }: ApiInvocationParams<RequestType>): Promise<{
    status: number;
    data: ResponseType | null;
  }> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data =
      res.status === 204 ? null : ((await res.json()) as ResponseType);

    if (expectedStatus && res.status !== expectedStatus) {
      const text = await res.text();
      const headers = res.headers.entries
        ? Array.from(res.headers.entries())
            .map(([k, v]) => `${k}: ${v}`)
            .join('\n')
        : undefined;
      const status = `Expected: ${expectedStatus}, Received: ${res.status} (${res.statusText})`;
      const parts = [status, headers, text].filter(Boolean);
      throw new Error(parts.join('\n\n'));
    }
    return { status: res.status, data };
  }
}
