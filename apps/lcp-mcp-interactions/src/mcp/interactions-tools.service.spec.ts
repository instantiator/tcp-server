import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { AuditClientService } from '@lcp/shared';
import { InteractionsToolsService } from './interactions-tools.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeConfig(vals: Record<string, string> = {}): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => vals[key] ?? 'http://localhost:3000'),
  } as unknown as ConfigService;
}

function makeAudit(): AuditClientService {
  return { record: jest.fn() } as unknown as AuditClientService;
}

async function callTool(
  service: InteractionsToolsService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = service.createServer();
  // Access tools via the internal _registeredTools object (SDK v0.x pattern)
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  const tools = (server as any)._registeredTools as Record<
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
  let audit: AuditClientService;
  let service: InteractionsToolsService;
  let axiosPost: jest.Mock;

  const agentId = randomUUID();
  const companyId = randomUUID();

  let axiosGet: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    config = makeConfig({
      LCP_SERVER_URL: 'http://lcp-server:3000',
      LCP_STORAGE_URL: 'http://lcp-mcp-storage:3010',
      INTERNAL_API_KEY: 'test-key',
    });
    audit = makeAudit();
    service = new InteractionsToolsService(audit, config);
    // Spy on axios.post to get a bound reference (avoids @typescript-eslint/unbound-method)
    axiosPost = jest.spyOn(mockedAxios, 'post') as unknown as jest.Mock;
    axiosGet = jest.spyOn(mockedAxios, 'get') as unknown as jest.Mock;
  });

  describe('describe_server', () => {
    it('returns an overview describing available tools', async () => {
      const text = await callTool(service, 'describe_server', {});
      expect(text).toContain('Interactions Service');
      expect(text).toContain('request_user_input');
      expect(text).toContain('complete_task');
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
        'http://lcp-server:3000/internal/pause',
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
  });

  describe('request_agent_consultation', () => {
    it('calls POST /internal/pause with consultation type and returns message', async () => {
      const consultationId = randomUUID();
      mockedAxios.post.mockResolvedValue({ data: { consultationId } });

      const text = await callTool(service, 'request_agent_consultation', {
        agentId,
        companyId,
        roleName: 'legal-advisor',
        question: 'Is this legal?',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/pause',
        expect.objectContaining({
          type: 'agent_consultation',
          roleName: 'legal-advisor',
        }),
        expect.any(Object),
      );
      expect(text).toContain('legal-advisor');
      expect(text).toContain('Paused');
    });
  });

  describe('complete_task', () => {
    it('calls POST /internal/agent/:agentId/complete and returns confirmation', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'complete_task', {
        agentId,
        companyId,
        finalAnswer: 'The analysis is complete. See report.md.',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/agent/${agentId}/complete`,
        { output: 'The analysis is complete. See report.md.' },
        expect.objectContaining({
          headers: { 'X-Internal-Api-Key': 'test-key' },
        }),
      );
      expect(text).toContain('complete');
    });

    it('returns error message when complete fails', async () => {
      mockedAxios.post.mockRejectedValue(new Error('Server error'));

      const text = await callTool(service, 'complete_task', {
        agentId,
        companyId,
        finalAnswer: 'Done.',
      });

      expect(text).toContain('Error');
    });

    it('completes successfully when all outputFiles exist', async () => {
      // GET /files/exists → no missing; GET /internal/agent → storageChanges; POST complete
      axiosGet.mockResolvedValueOnce({ data: { missing: [] } }); // files/exists
      mockedAxios.post.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'complete_task', {
        agentId,
        companyId,
        finalAnswer: 'Done.',
        outputFiles: ['docs/report.md'],
      });

      expect(axiosGet).toHaveBeenCalledWith(
        expect.stringContaining('/files/exists'),
        expect.objectContaining({
          headers: { 'X-Internal-Api-Key': 'test-key' },
        }),
      );
      expect(text).toContain('complete');
    });

    it('returns missing-files error and does not complete when outputFiles are absent', async () => {
      axiosGet
        .mockResolvedValueOnce({ data: { missing: ['docs/missing.md'] } }) // files/exists
        .mockResolvedValueOnce({
          // internal/agent
          data: {
            storageChanges: { created: ['docs/report.md'], modified: [] },
          },
        });

      const text = await callTool(service, 'complete_task', {
        agentId,
        companyId,
        finalAnswer: 'Done.',
        outputFiles: ['docs/missing.md'],
      });

      expect(axiosPost).not.toHaveBeenCalled();
      expect(text).toContain('docs/missing.md');
      expect(text).toContain('docs/report.md');
    });

    it('fails open (completes) when the storage check itself errors', async () => {
      axiosGet.mockRejectedValue(new Error('Storage unreachable'));
      mockedAxios.post.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'complete_task', {
        agentId,
        companyId,
        finalAnswer: 'Done.',
        outputFiles: ['docs/report.md'],
      });

      // Storage check failed, so should proceed with completion
      expect(text).toContain('complete');
    });

    it('skips file check when outputFiles is omitted', async () => {
      mockedAxios.post.mockResolvedValue({ data: {} });

      await callTool(service, 'complete_task', {
        agentId,
        companyId,
        finalAnswer: 'Done.',
      });

      expect(axiosGet).not.toHaveBeenCalled();
      expect(axiosPost).toHaveBeenCalled();
    });
  });
});
