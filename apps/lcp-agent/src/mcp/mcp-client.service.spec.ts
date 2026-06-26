import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpClientService } from './mcp-client.service';

jest.mock('@modelcontextprotocol/sdk/client/index.js');
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MockClient = jest.mocked(Client);
const MockTransport = jest.mocked(StreamableHTTPClientTransport);

function makeClientInstance(tools: object[] = []) {
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    listTools: jest.fn().mockResolvedValue({ tools }),
    callTool: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('McpClientService', () => {
  let service: McpClientService;

  beforeEach(() => {
    service = new McpClientService();
    MockTransport.mockImplementation(
      () => ({}) as StreamableHTTPClientTransport,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('loadTools', () => {
    it('returns empty array when serverNames is empty', async () => {
      const tools = await service.loadTools([], {});
      expect(tools).toEqual([]);
    });

    it('skips a server with no URL configured and logs a warning', async () => {
      const tools = await service.loadTools(['memory'], {});
      expect(tools).toEqual([]);
      expect(MockClient).not.toHaveBeenCalled();
    });

    it('loads tools from a single server', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'recall',
          description: 'Recall memories',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ]);
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const tools = await service.loadTools(['memory'], {
        memory: 'http://localhost:3011',
      });
      expect(tools).toHaveLength(1);
      expect(tools[0].toolName).toBe('memory__recall');
      expect(tools[0].serverName).toBe('memory');
    });

    it('prefixes tool names with the server name', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'list_files',
          description: 'List',
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'read_file',
          description: 'Read',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const tools = await service.loadTools(['storage'], {
        storage: 'http://localhost:3010',
      });
      expect(tools.map((t) => t.toolName)).toEqual([
        'storage__list_files',
        'storage__read_file',
      ]);
    });

    it('skips a failing server and continues loading others', async () => {
      const goodClient = makeClientInstance([
        {
          name: 'describe_server',
          description: 'Desc',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      let callCount = 0;
      MockClient.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return {
            connect: jest
              .fn()
              .mockRejectedValue(new Error('connection refused')),
            close: jest.fn().mockResolvedValue(undefined),
          } as unknown as Client;
        }
        return goodClient as unknown as Client;
      });

      const tools = await service.loadTools(['broken', 'memory'], {
        broken: 'http://bad:9999',
        memory: 'http://localhost:3011',
      });
      expect(tools).toHaveLength(1);
      expect(tools[0].serverName).toBe('memory');
    });

    it('closes the client even when listTools throws', async () => {
      const clientInstance = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockRejectedValue(new Error('bad response')),
        close: jest.fn().mockResolvedValue(undefined),
      };
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      await service.loadTools(['memory'], { memory: 'http://localhost:3011' });
      expect(clientInstance.close).toHaveBeenCalled();
    });

    it('builds a callable LangChain tool from an MCP tool', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'recall',
          description: 'Recall',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ]);
      clientInstance.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'result text' }],
      });
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const [mcpTool] = await service.loadTools(['memory'], {
        memory: 'http://localhost:3011',
      });
      const output: unknown = await mcpTool.tool.invoke({
        query: 'test query',
      });
      expect(output).toBe('result text');
    });

    it('returns empty string when callTool produces no text content', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'noop',
          description: '',
          inputSchema: { type: 'object', properties: {} },
        },
      ]);
      clientInstance.callTool.mockResolvedValue({ content: [] });
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const [mcpTool] = await service.loadTools(['svc'], {
        svc: 'http://localhost:3020',
      });
      const output: unknown = await mcpTool.tool.invoke({});
      expect(output).toBe('');
    });
  });
});
