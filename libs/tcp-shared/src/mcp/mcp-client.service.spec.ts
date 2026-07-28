import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
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

    it('preserves a string field enum as a Zod enum and keeps its description', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'assure_assignment',
          description: 'Record a QA verdict',
          inputSchema: {
            type: 'object',
            properties: {
              qa: {
                type: 'string',
                enum: ['accept', 'reject'],
                description: 'Your verdict on the assignment under review.',
              },
            },
            required: ['qa'],
          },
        },
      ]);
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const [mcpTool] = await service.loadTools(['tasks'], {
        tasks: 'http://localhost:3013',
      });
      const shape = (
        mcpTool.tool.schema as { shape: Record<string, z.ZodType> }
      ).shape;

      expect(shape.qa.description).toBe(
        'Your verdict on the assignment under review.',
      );
      expect(shape.qa.safeParse('accept').success).toBe(true);
      expect(shape.qa.safeParse('Accept').success).toBe(false);
    });

    it('preserves a plain string field description', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'read_working_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'The object key to read.' },
            },
            required: ['path'],
          },
        },
      ]);
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const [mcpTool] = await service.loadTools(['storage'], {
        storage: 'http://localhost:3010',
      });
      const shape = (
        mcpTool.tool.schema as { shape: Record<string, z.ZodType> }
      ).shape;

      expect(shape.path.description).toBe('The object key to read.');
    });

    // The two specs above cover top-level fields. These cover the recursive
    // branches — array items and nested objects — where the same enum/
    // description preservation is easiest to drop silently, since the model
    // still receives a structurally valid schema either way.
    it('preserves an array item field enum and description', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'complete_assignment',
          description: 'Submit finished work',
          inputSchema: {
            type: 'object',
            properties: {
              prepared: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['file', 'text'],
                  description: 'How to interpret each prepared artifact.',
                },
              },
            },
            required: ['prepared'],
          },
        },
      ]);
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const [mcpTool] = await service.loadTools(['tasks'], {
        tasks: 'http://localhost:3013',
      });
      const shape = (
        mcpTool.tool.schema as { shape: Record<string, z.ZodType> }
      ).shape;
      const element = (shape.prepared as unknown as { element: z.ZodType })
        .element;

      expect(element.description).toBe(
        'How to interpret each prepared artifact.',
      );
      expect(element.safeParse('file').success).toBe(true);
      expect(element.safeParse('directory').success).toBe(false);
    });

    it('preserves a nested object property enum and description', async () => {
      const clientInstance = makeClientInstance([
        {
          name: 'create_plan',
          description: 'Plan a task',
          inputSchema: {
            type: 'object',
            properties: {
              artifact: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['file', 'text'],
                    description: 'Artifact kind.',
                  },
                },
                required: ['type'],
              },
            },
            required: ['artifact'],
          },
        },
      ]);
      MockClient.mockImplementation(() => clientInstance as unknown as Client);

      const [mcpTool] = await service.loadTools(['tasks'], {
        tasks: 'http://localhost:3013',
      });
      const shape = (
        mcpTool.tool.schema as { shape: Record<string, z.ZodType> }
      ).shape;
      const inner = (
        shape.artifact as unknown as { shape: Record<string, z.ZodType> }
      ).shape;

      expect(inner.type.description).toBe('Artifact kind.');
      expect(inner.type.safeParse('text').success).toBe(true);
      expect(inner.type.safeParse('paragraph').success).toBe(false);
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

    describe('identity context (agentId / companyId)', () => {
      function makeConsultationTool() {
        return makeClientInstance([
          {
            name: 'request_agent_consultation',
            description: 'Consult another role',
            inputSchema: {
              type: 'object',
              properties: {
                agentId: { type: 'string' },
                companyId: { type: 'string' },
                roleId: { type: 'string' },
                question: { type: 'string' },
              },
              required: ['agentId', 'companyId', 'roleId', 'question'],
            },
          },
        ]);
      }

      it('hides agentId/companyId from the LangChain-facing schema when context supplies them', async () => {
        const clientInstance = makeConsultationTool();
        MockClient.mockImplementation(
          () => clientInstance as unknown as Client,
        );

        const [mcpTool] = await service.loadTools(
          ['interactions'],
          { interactions: 'http://localhost:3012' },
          { agentId: 'real-agent-id', companyId: 'real-company-id' },
        );

        const shape = (
          mcpTool.tool.schema as { shape: Record<string, unknown> }
        ).shape;
        expect(shape).not.toHaveProperty('agentId');
        expect(shape).not.toHaveProperty('companyId');
        expect(shape).toHaveProperty('roleId');
        expect(shape).toHaveProperty('question');
      });

      it('injects the real agentId/companyId on every call, overriding anything the LLM supplies', async () => {
        const clientInstance = makeConsultationTool();
        MockClient.mockImplementation(
          () => clientInstance as unknown as Client,
        );

        const [mcpTool] = await service.loadTools(
          ['interactions'],
          { interactions: 'http://localhost:3012' },
          { agentId: 'real-agent-id', companyId: 'real-company-id' },
        );

        await mcpTool.tool.invoke({
          // An LLM that somehow still supplied these (e.g. a malformed call)
          // must not be able to override the real values.
          agentId: 'guessed-agent-id',
          companyId: 'guessed-company-id',
          roleId: 'role-1',
          question: 'Would you like a worm?',
        });

        expect(clientInstance.callTool).toHaveBeenCalledWith({
          name: 'request_agent_consultation',
          arguments: {
            agentId: 'real-agent-id',
            companyId: 'real-company-id',
            roleId: 'role-1',
            question: 'Would you like a worm?',
          },
        });
      });

      it('leaves tools that do not declare agentId/companyId unaffected by context', async () => {
        const clientInstance = makeClientInstance([
          {
            name: 'list_files',
            description: 'List',
            inputSchema: {
              type: 'object',
              properties: { prefix: { type: 'string' } },
            },
          },
        ]);
        MockClient.mockImplementation(
          () => clientInstance as unknown as Client,
        );

        const [mcpTool] = await service.loadTools(
          ['storage'],
          { storage: 'http://localhost:3010' },
          { agentId: 'real-agent-id', companyId: 'real-company-id' },
        );

        await mcpTool.tool.invoke({ prefix: 'docs/' });

        expect(clientInstance.callTool).toHaveBeenCalledWith({
          name: 'list_files',
          arguments: { prefix: 'docs/' },
        });
      });

      it('does not strip or override fields when no context is given', async () => {
        const clientInstance = makeConsultationTool();
        MockClient.mockImplementation(
          () => clientInstance as unknown as Client,
        );

        const [mcpTool] = await service.loadTools(['interactions'], {
          interactions: 'http://localhost:3012',
        });

        const shape = (
          mcpTool.tool.schema as { shape: Record<string, unknown> }
        ).shape;
        expect(shape).toHaveProperty('agentId');
        expect(shape).toHaveProperty('companyId');
      });
    });
  });
});
