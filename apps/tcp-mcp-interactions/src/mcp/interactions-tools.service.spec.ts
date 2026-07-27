import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { InteractionsToolsService } from './interactions-tools.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeConfig(vals: Record<string, string> = {}): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => vals[key] ?? 'http://localhost:3000'),
  } as unknown as ConfigService;
}

async function callTool(
  service: InteractionsToolsService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = service.createServer();
  // Access tools via the internal _registeredTools object (SDK v0.x pattern)
  const tools = (server as unknown as { _registeredTools: unknown })
    ._registeredTools as Record<
    string,
    {
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[] }>;
    }
  >;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool '${toolName}' not found`);
  const result = await tool.handler(args);
  return result.content[0].text;
}

describe('InteractionsToolsService', () => {
  let config: ConfigService;
  let service: InteractionsToolsService;
  let axiosPost: jest.Mock;

  const agentId = randomUUID();
  const companyId = randomUUID();

  let axiosGet: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    config = makeConfig({
      LCP_SERVER_URL: 'http://tcp-server:3000',
      INTERNAL_API_KEY: 'test-key',
    });
    service = new InteractionsToolsService(config);
    // Spy on axios.post to get a bound reference (avoids @typescript-eslint/unbound-method)
    axiosPost = jest.spyOn(mockedAxios, 'post') as unknown as jest.Mock;
    axiosGet = jest.spyOn(mockedAxios, 'get') as unknown as jest.Mock;
  });

  describe('describe_server', () => {
    it('returns an overview describing available tools without completion', async () => {
      const text = await callTool(service, 'describe_server', {});
      expect(text).toContain('Interactions Service');
      expect(text).not.toContain('complete_task');
    });
  });

  describe('list_available_contacts', () => {
    it("kind: 'roles' calls GET /internal/company/:companyId/roles and returns the raw list", async () => {
      const roles = [{ id: randomUUID(), name: 'analyst' }];
      axiosGet.mockResolvedValue({ data: roles });

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
        kind: 'roles',
      });

      expect(axiosGet).toHaveBeenCalledWith(
        `http://tcp-server:3000/internal/company/${companyId}/roles`,
        { headers: { 'X-Internal-Api-Key': 'test-key' } },
      );
      expect(text).toContain('analyst');
    });

    it("kind: 'roles' returns error message when the request fails", async () => {
      axiosGet.mockRejectedValue(new Error('Network error'));

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
        kind: 'roles',
      });

      expect(text).toContain('Error');
    });

    it("kind: 'users' calls GET /internal/company/:companyId/users and returns the raw list", async () => {
      const users = [{ id: randomUUID(), identifier: 'alice' }];
      axiosGet.mockResolvedValue({ data: users });

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
        kind: 'users',
      });

      expect(axiosGet).toHaveBeenCalledWith(
        `http://tcp-server:3000/internal/company/${companyId}/users`,
        { headers: { 'X-Internal-Api-Key': 'test-key' } },
      );
      expect(text).toContain('alice');
    });

    it("kind: 'users' returns error message when the request fails", async () => {
      axiosGet.mockRejectedValue(new Error('Network error'));

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
        kind: 'users',
      });

      expect(text).toContain('Error');
    });

    it('folds case and whitespace on kind (e.g. "Users") before deciding which collections to fetch', async () => {
      const users = [{ id: randomUUID(), identifier: 'alice' }];
      axiosGet.mockResolvedValue({ data: users });

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
        kind: ' Users ',
      });

      expect(axiosGet).toHaveBeenCalledTimes(1);
      expect(axiosGet).toHaveBeenCalledWith(
        `http://tcp-server:3000/internal/company/${companyId}/users`,
        { headers: { 'X-Internal-Api-Key': 'test-key' } },
      );
      expect(text).toContain('alice');
    });

    it('defaults to both when kind is omitted, fetching users and roles in one call', async () => {
      const users = [{ id: randomUUID(), identifier: 'alice' }];
      const roles = [{ id: randomUUID(), name: 'analyst' }];
      axiosGet.mockImplementation((url: string) =>
        Promise.resolve({ data: url.endsWith('/users') ? users : roles }),
      );

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
      });

      expect(axiosGet).toHaveBeenCalledTimes(2);
      expect(text).toContain('alice');
      expect(text).toContain('analyst');
    });

    it('reports one collection as an error without hiding the other when only one fetch fails', async () => {
      axiosGet.mockImplementation((url: string) =>
        url.endsWith('/users')
          ? Promise.reject(new Error('Network error'))
          : Promise.resolve({ data: [{ id: randomUUID(), name: 'analyst' }] }),
      );

      const text = await callTool(service, 'list_available_contacts', {
        companyId,
        kind: 'both',
      });

      expect(text).toContain('analyst');
      expect(text).toContain('Could not retrieve user list.');
    });
  });

  describe('request_user_input', () => {
    it('calls POST /internal/pause and returns slug message on success', async () => {
      mockedAxios.post.mockResolvedValue({ data: { slug: 'analyst-5' } });

      const text = await callTool(service, 'request_user_input', {
        agentId,
        companyId,
        question: 'What is the plan?',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        'http://tcp-server:3000/internal/pause',
        expect.objectContaining({
          type: 'user_input',
          agentId,
          question: 'What is the plan?',
        }),
        expect.objectContaining({
          headers: { 'X-Internal-Api-Key': 'test-key' },
        }),
      );
      expect(text).toContain('analyst-5');
      expect(text).toContain('Paused');
    });

    it('returns error message when request fails', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      const text = await callTool(service, 'request_user_input', {
        agentId,
        companyId,
        question: 'Will this break?',
      });

      expect(text).toContain('Error');
    });

    it('forwards userIds when targeting specific users', async () => {
      mockedAxios.post.mockResolvedValue({ data: { slug: 'analyst-6' } });
      const userIds = [randomUUID(), randomUUID()];

      await callTool(service, 'request_user_input', {
        agentId,
        companyId,
        question: 'What is the plan?',
        userIds,
      });

      expect(axiosPost).toHaveBeenCalledWith(
        'http://tcp-server:3000/internal/pause',
        expect.objectContaining({ type: 'user_input', userIds }),
        expect.any(Object),
      );
    });
  });

  describe('request_agent_consultation', () => {
    it('calls POST /internal/pause with the roleId and returns the resolved role name', async () => {
      const consultationId = randomUUID();
      const roleId = randomUUID();
      mockedAxios.post.mockResolvedValue({
        data: { consultationId, roleName: 'Legal Advisor' },
      });

      const text = await callTool(service, 'request_agent_consultation', {
        agentId,
        companyId,
        roleId,
        question: 'Is this legal?',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        'http://tcp-server:3000/internal/pause',
        expect.objectContaining({
          type: 'agent_consultation',
          roleId,
        }),
        expect.any(Object),
      );
      expect(text).toContain('Legal Advisor');
      expect(text).toContain('Paused');
    });

    it('forwards an optional roleName label alongside roleId', async () => {
      const consultationId = randomUUID();
      const roleId = randomUUID();
      mockedAxios.post.mockResolvedValue({
        data: { consultationId, roleName: 'Legal Advisor' },
      });

      await callTool(service, 'request_agent_consultation', {
        agentId,
        companyId,
        roleId,
        roleName: 'legal-advisor',
        question: 'Is this legal?',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        'http://tcp-server:3000/internal/pause',
        expect.objectContaining({ roleId, roleName: 'legal-advisor' }),
        expect.any(Object),
      );
    });

    it('falls back to roleId in the error message when the request fails and no roleName was given', async () => {
      const roleId = randomUUID();
      mockedAxios.post.mockRejectedValue(new Error('Network error'));

      const text = await callTool(service, 'request_agent_consultation', {
        agentId,
        companyId,
        roleId,
        question: 'Is this legal?',
      });

      expect(text).toContain('Error');
      expect(text).toContain(roleId);
    });

    it('relays a 4xx corrective message (e.g. unknown role naming valid roles) so the model can retry', async () => {
      const corrective =
        'One value was not valid:\n- role: "ghost" is not one of the allowed values. Valid values are: chicken-assistant, cat-assistant.\nIf you still intend to consult that role, try again with corrected values for role.';
      mockedAxios.post.mockRejectedValue({
        response: { status: 404, data: { message: corrective } },
      });

      const text = await callTool(service, 'request_agent_consultation', {
        agentId,
        companyId,
        roleSlug: 'ghost',
        question: 'Is this legal?',
      });

      // Relayed verbatim as a normal (non-"Error:") result, naming valid roles.
      expect(text).toContain(
        'Valid values are: chicken-assistant, cat-assistant.',
      );
      expect(text).not.toContain('Error:');
    });
  });
});
