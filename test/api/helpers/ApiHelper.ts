import { randomUUID, UUID } from 'crypto';
import { DeepPartial } from 'typeorm';
import { LcpCompany, LcpRole } from '../../../libs/lcp-shared/src/models';

export const BASE = process.env.LCP_SERVER_URL ?? 'http://localhost:3000';
export const USERNAME = process.env.TEST_USERNAME ?? 'test';
export const PASSWORD = process.env.TEST_PASSWORD ?? 'test';

/** Unique suffix so repeated runs don't collide on slug constraints. */
export const RUN_ID = Date.now().toString(36);

export interface ApiInvocationParams<RequestType> {
  method: 'POST' | 'PUT' | 'GET' | 'DELETE';
  path: string;
  body?: DeepPartial<RequestType>;
  expectedStatus?: number;
  token?: string;
}

interface TokenRequest {
  username: string;
  password: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
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

  static async postCredentialsForToken(
    username: string,
    password: string,
    expectedStatus?: number,
  ) {
    const { status, data } = await this.invokeApi<TokenRequest, TokenResponse>({
      method: 'POST',
      path: '/api/auth/token',
      body: { username: username, password: password },
      expectedStatus: expectedStatus ?? 200,
    });
    if (status === 200) {
      expect(data?.access_token).toBeDefined();
      expect(data!.access_token.length).toBeGreaterThan(0);
    }
    return data!.access_token;
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
    const { data } = await this.invokeApi<undefined, LcpRole[]>({
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
    const { data } = await this.invokeApi<LcpCompany, LcpCompany>({
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

  async updateCompany(id: UUID, changes: DeepPartial<LcpCompany>) {
    const { data } = await this.invokeApi<LcpCompany, LcpCompany>({
      method: 'PUT',
      path: `/api/company/${id}`,
      body: changes,
      expectedStatus: 200,
    });
    expect(data?.id).toEqual(id);
    return data!;
  }

  async createTestRole(name: string, companyId: UUID) {
    const { data } = await this.invokeApi<LcpRole, LcpRole>({
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

  async updateRole(id: UUID, changes: DeepPartial<LcpRole>) {
    const { data } = await this.invokeApi<LcpRole, LcpRole>({
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
   * through {@link invokeApi} since that only sends JSON bodies.
   */
  async storeKnowledge(
    scopePath: string,
    filename: string,
    content: string,
    expectedStatus = 201,
  ) {
    const form = new FormData();
    form.append(
      'file',
      new Blob([content], { type: 'text/markdown' }),
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
    if (expectedStatus) {
      expect(res.status).toBe(expectedStatus);
    }
    return { status: res.status, data };
  }
}
