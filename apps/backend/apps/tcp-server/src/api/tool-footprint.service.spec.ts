import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  ContextBudgetService,
  McpClientService,
  McpServerUnavailableError,
  type McpTool,
  type TcpCompany,
  type TcpRole,
} from '@tcp/shared';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { ToolFootprintService } from './tool-footprint.service';

const URLS = {
  MCP_TASKS_URL: 'http://tasks:3013',
  MCP_STORAGE_URL: 'http://storage:3010',
  MCP_RECORDS_URL: 'http://records:3015',
  MCP_INTERACTIONS_URL: 'http://interactions:3012',
};

function tool(serverName: string, toolName: string): McpTool {
  return {
    serverName,
    toolName: `${serverName}__${toolName}`,
    tool: new DynamicStructuredTool({
      name: `${serverName}__${toolName}`,
      description: `The ${toolName} tool, described at some length for counting.`,
      schema: z.object({ table: z.string().describe('Table name') }),
      func: () => Promise.resolve(''),
    }),
  };
}

const TOOLS: Record<string, McpTool[]> = {
  tasks: [tool('tasks', 'create_plan')],
  storage: [
    tool('storage', 'read_working_file'),
    tool('storage', 'create_working_file'),
  ],
  records: [tool('records', 'query'), tool('records', 'insert')],
  interactions: [tool('interactions', 'request_user_input')],
};

describe('ToolFootprintService', () => {
  const company = { id: 'c1', mcpServerList: [] } as unknown as TcpCompany;
  const role = { mcpServerList: [] } as unknown as TcpRole;
  let loadTools: jest.Mock;
  let service: ToolFootprintService;

  beforeEach(() => {
    loadTools = jest.fn((names: string[]) =>
      Promise.resolve(TOOLS[names[0]] ?? []),
    );
    service = new ToolFootprintService(
      new ConfigService(URLS),
      { loadTools } as unknown as McpClientService,
      new ContextBudgetService(),
    );
  });

  it('counts each server separately and totals them', async () => {
    const result = await service.footprint(company, role, 'implement');
    expect(result.servers.map((s) => [s.name, s.tools])).toEqual([
      ['storage', 2],
      ['interactions', 1],
      ['tasks', 1],
      ['records', 2],
    ]);
    expect(result.servers.every((s) => s.tokens > 0)).toBe(true);
    expect(result.total).toBe(
      result.servers.reduce((sum, s) => sum + s.tokens, 0),
    );
  });

  it('injects identity, so identity parameters are not counted', async () => {
    await service.footprint(company, role, 'implement');
    expect(loadTools).toHaveBeenCalledWith(
      ['records'],
      expect.any(Object),
      expect.objectContaining({ companyId: 'c1' }),
      { required: true },
    );
  });

  it("follows the mode: plan drops interactions and records' write tools", async () => {
    const result = await service.footprint(company, role, 'plan');
    expect(result.servers.map((s) => s.name)).not.toContain('interactions');
    expect(result.servers.find((s) => s.name === 'records')?.tools).toBe(1);
    expect(result.servers.find((s) => s.name === 'storage')?.tools).toBe(1);
  });

  it('leaves out servers the role switches off', async () => {
    const lean = { ...role, mcpServerToggles: { records: false } } as TcpRole;
    const result = await service.footprint(company, lean, 'implement');
    expect(result.servers.map((s) => s.name)).not.toContain('records');
    expect(loadTools).not.toHaveBeenCalledWith(
      ['records'],
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('reports a server it cannot reach, and counts the rest', async () => {
    loadTools.mockImplementation((names: string[]) =>
      names[0] === 'records'
        ? Promise.reject(
            new McpServerUnavailableError('records', 'ECONNREFUSED'),
          )
        : Promise.resolve(TOOLS[names[0]] ?? []),
    );
    const result = await service.footprint(company, role, 'implement');
    expect(result.servers.find((s) => s.name === 'records')).toMatchObject({
      tokens: 0,
      error: expect.stringContaining('ECONNREFUSED') as unknown,
    });
    expect(result.total).toBeGreaterThan(0);
  });
});
