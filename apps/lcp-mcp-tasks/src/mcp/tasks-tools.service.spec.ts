import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { AuditClientService } from '@tcp/shared';
import { TasksToolsService } from './tasks-tools.service';

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
  service: TasksToolsService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = service.createServer();
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

/** Resolves GET /internal/agent/:id/assignment to the given assignment shape. */
function mockAssignment(
  axiosGet: jest.Mock,
  assignment: Record<string, unknown>,
): void {
  axiosGet.mockResolvedValue({ data: { assignment } });
}

describe('TasksToolsService', () => {
  let service: TasksToolsService;
  let axiosPost: jest.Mock;
  let axiosGet: jest.Mock;

  const agentId = randomUUID();
  const companyId = randomUUID();
  const taskId = randomUUID();
  const assignmentId = randomUUID();
  const targetId = randomUUID();

  beforeEach(() => {
    jest.clearAllMocks();
    const config = makeConfig({
      LCP_SERVER_URL: 'http://lcp-server:3000',
      INTERNAL_API_KEY: 'test-key',
    });
    service = new TasksToolsService(makeAudit(), config);
    axiosPost = jest.spyOn(mockedAxios, 'post') as unknown as jest.Mock;
    axiosGet = jest.spyOn(mockedAxios, 'get') as unknown as jest.Mock;
  });

  describe('describe_server', () => {
    it('describes all three mode tools', async () => {
      const text = await callTool(service, 'describe_server', {});
      expect(text).toContain('Tasks Service');
      expect(text).toContain('create_plan');
      expect(text).toContain('complete_assignment');
      expect(text).toContain('assure_assignment');
    });

    it('names the caller’s mode when an agentId is supplied', async () => {
      mockAssignment(axiosGet, { id: assignmentId, mode: 'qa', taskId: null });
      const text = await callTool(service, 'describe_server', { agentId });
      expect(text).toContain('qa');
      expect(text).toContain('assure_assignment');
    });

    it('names complete_assignment as the completion tool for a chat-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'chat',
        taskId: null,
      });
      const text = await callTool(service, 'describe_server', { agentId });
      expect(text).toContain('chat');
    });

    it('names complete_assignment as the completion tool for a consultee-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'consultee',
        taskId: null,
      });
      const text = await callTool(service, 'describe_server', { agentId });
      expect(text).toContain('consultee');
      expect(text).toContain('complete_assignment');
    });

    it('names complete_assignment as the completion tool for a finalise-mode caller', async () => {
      mockAssignment(axiosGet, { id: assignmentId, mode: 'finalise', taskId });
      const text = await callTool(service, 'describe_server', { agentId });
      expect(text).toContain('finalise');
      expect(text).toContain('complete_assignment');
    });
  });

  describe('create_plan', () => {
    it('proxies to the plan endpoint for a plan-mode caller', async () => {
      mockAssignment(axiosGet, { id: assignmentId, mode: 'plan', taskId });
      axiosPost.mockResolvedValue({ data: { created: 3 } });

      const text = await callTool(service, 'create_plan', {
        agentId,
        companyId,
        assignments: [{ prompt: 'a', role: 'analyst', expected: [] }],
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/task/${taskId}/plan`,
        expect.objectContaining({ agentId }),
        expect.objectContaining({
          headers: { 'X-Internal-Api-Key': 'test-key' },
        }),
      );
      expect(text).toContain('3');
    });

    it('refuses a non-plan-mode caller and names the right tool', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'implement',
        taskId,
      });
      const text = await callTool(service, 'create_plan', {
        agentId,
        companyId,
        assignments: [{ prompt: 'a', role: 'analyst', expected: [] }],
      });
      expect(axiosPost).not.toHaveBeenCalled();
      expect(text).toContain('complete_assignment');
    });

    it('relays a 4xx validation message verbatim as a normal result', async () => {
      mockAssignment(axiosGet, { id: assignmentId, mode: 'plan', taskId });
      axiosPost.mockRejectedValue({
        response: { status: 400, data: { message: "role 'ghost' not found" } },
      });
      const text = await callTool(service, 'create_plan', {
        agentId,
        companyId,
        assignments: [{ prompt: 'a', role: 'ghost', expected: [] }],
      });
      expect(text).toContain("role 'ghost' not found");
      expect(text).not.toContain('Error:');
    });
  });

  describe('complete_assignment', () => {
    it('proxies to the complete endpoint for an implement-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'implement',
        taskId: null,
      });
      axiosPost.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'complete_assignment', {
        agentId,
        companyId,
        summary: 'done',
        prepared: [],
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/assignment/${assignmentId}/complete`,
        expect.objectContaining({ agentId, summary: 'done' }),
        expect.any(Object),
      );
      expect(text).toContain('submitted');
    });

    it('returns a 422 gate failure as a normal (correctable) result', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'implement',
        taskId: null,
      });
      axiosPost.mockRejectedValue({
        response: {
          status: 422,
          data: { message: "Expected file 'report.md' was not provided." },
        },
      });
      const text = await callTool(service, 'complete_assignment', {
        agentId,
        companyId,
        summary: 'done',
        prepared: [],
      });
      expect(text).toContain('report.md');
      expect(text).not.toContain('Error:');
    });

    it('refuses a non-implement-mode caller', async () => {
      mockAssignment(axiosGet, { id: assignmentId, mode: 'plan', taskId });
      const text = await callTool(service, 'complete_assignment', {
        agentId,
        companyId,
        summary: 'done',
        prepared: [],
      });
      expect(axiosPost).not.toHaveBeenCalled();
      expect(text).toContain('create_plan');
    });

    it('proxies to the complete endpoint for a consultee-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'consultee',
        taskId: null,
      });
      axiosPost.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'complete_assignment', {
        agentId,
        companyId,
        summary: 'answered',
        prepared: [],
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/assignment/${assignmentId}/complete`,
        expect.objectContaining({ agentId, summary: 'answered' }),
        expect.any(Object),
      );
      expect(text).toContain('submitted');
    });

    it('proxies to the complete endpoint for a finalise-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'finalise',
        taskId,
      });
      axiosPost.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'complete_assignment', {
        agentId,
        companyId,
        summary: 'finalised',
        prepared: [],
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/assignment/${assignmentId}/complete`,
        expect.objectContaining({ agentId, summary: 'finalised' }),
        expect.any(Object),
      );
      expect(text).toContain('submitted');
    });
  });

  describe('assure_assignment', () => {
    it('proxies to the assure endpoint for a qa-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'qa',
        taskId: null,
        targetAssignmentId: targetId,
      });
      axiosPost.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'assure_assignment', {
        agentId,
        companyId,
        qa: 'reject',
        feedback: 'fix it',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/assignment/${targetId}/assure`,
        expect.objectContaining({ agentId, qa: 'reject', feedback: 'fix it' }),
        expect.any(Object),
      );
      expect(text).toContain('rejected');
    });

    it('folds case and whitespace on the qa verdict before proxying and replying', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'qa',
        taskId: null,
        targetAssignmentId: targetId,
      });
      axiosPost.mockResolvedValue({ data: {} });

      const text = await callTool(service, 'assure_assignment', {
        agentId,
        companyId,
        qa: ' Accept ',
      });

      expect(axiosPost).toHaveBeenCalledWith(
        `http://lcp-server:3000/internal/assignment/${targetId}/assure`,
        expect.objectContaining({ agentId, qa: 'accept' }),
        expect.any(Object),
      );
      expect(text).toContain('accepted');
    });

    it('refuses a non-qa-mode caller', async () => {
      mockAssignment(axiosGet, {
        id: assignmentId,
        mode: 'implement',
        taskId: null,
      });
      const text = await callTool(service, 'assure_assignment', {
        agentId,
        companyId,
        qa: 'accept',
      });
      expect(axiosPost).not.toHaveBeenCalled();
      expect(text).toContain('complete_assignment');
    });
  });

  it('reports when the caller’s assignment cannot be resolved', async () => {
    axiosGet.mockRejectedValue(new Error('boom'));
    const text = await callTool(service, 'create_plan', {
      agentId,
      companyId,
      assignments: [{ prompt: 'a', role: 'analyst', expected: [] }],
    });
    expect(text).toContain('Error');
  });
});
