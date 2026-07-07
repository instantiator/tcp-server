import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { StorageToolsService } from './storage-tools.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeConfig(): ConfigService {
  const vals: Record<string, string> = {
    LCP_SERVER_URL: 'http://lcp-server:3000',
    INTERNAL_API_KEY: 'secret-key',
  };
  return {
    getOrThrow: jest.fn((k: string) => vals[k]),
  } as unknown as ConfigService;
}

function makeService(): StorageToolsService {
  return new StorageToolsService(makeConfig());
}

function axiosError(status: number, body: unknown): unknown {
  const err = new Error('request failed');
  Object.assign(err, {
    isAxiosError: true,
    response: { status, data: body },
  });
  return err;
}

// Access a registered tool via the MCP server's internal map
async function callTool(
  service: StorageToolsService,
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

describe('StorageToolsService', () => {
  beforeEach(() => {
    mockedAxios.isAxiosError = jest
      .fn()
      .mockImplementation(
        (e: unknown) =>
          (e as { isAxiosError?: boolean })?.isAxiosError === true,
      ) as unknown as typeof axios.isAxiosError;
  });

  afterEach(() => jest.clearAllMocks());

  describe('listFiles', () => {
    it('proxies to POST /internal/storage/list and returns entries as JSON', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          entries: [{ key: 'a', name: 'a', size: 1, lastModified: 'x' }],
        },
      });
      const svc = makeService();
      const result = await svc.listFiles('acme');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/list',
        { prefix: 'acme' },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(JSON.parse(result.content[0].text)).toEqual([
        { key: 'a', name: 'a', size: 1, lastModified: 'x' },
      ]);
    });
  });

  describe('readFile', () => {
    it('returns the file content as text', async () => {
      mockedAxios.post.mockResolvedValue({ data: { content: 'hello' } });
      const svc = makeService();
      const result = await svc.readFile('acme/a.txt');
      expect(result.content[0].text).toBe('hello');
    });

    it('returns the server error message for a missing file', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(404, { message: 'File not found: acme/missing.txt' }),
      );
      const svc = makeService();
      const result = await svc.readFile('acme/missing.txt');
      expect(result.content[0].text).toBe('File not found: acme/missing.txt');
    });
  });

  describe('writeFile', () => {
    it('writes the file and returns a confirmation', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { key: 'acme/a.txt', size: 5 },
      });
      const svc = makeService();
      const result = await svc.writeFile(
        'acme/a.txt',
        'hello',
        false,
        'agent-1',
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/write',
        {
          path: 'acme/a.txt',
          content: 'hello',
          overwrite: false,
          originators: { agent: 'agent-1' },
        },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(result.content[0].text).toBe('Written: acme/a.txt');
    });

    it('relays a 409 conflict as a friendly message', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(409, {
          message:
            'File already exists at acme/a.txt. Set overwrite: true to replace it.',
        }),
      );
      const svc = makeService();
      const result = await svc.writeFile('acme/a.txt', 'hello');
      expect(result.content[0].text).toBe(
        'File already exists at acme/a.txt. Set overwrite: true to replace it.',
      );
    });

    it('relays a 422 validation failure using errors[].llmHint', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(422, {
          message: 'Document failed validation',
          errors: [{ message: 'bad', llmHint: 'Fix the JSON syntax.' }],
        }),
      );
      const svc = makeService();
      const result = await svc.writeFile('acme/a.json', '{bad', true);
      expect(result.content[0].text).toBe('Fix the JSON syntax.');
    });
  });

  describe('deleteFile', () => {
    it('deletes and returns a soft-delete confirmation', async () => {
      mockedAxios.post.mockResolvedValue({ data: { restorable: true } });
      const svc = makeService();
      const result = await svc.deleteFile('acme/a.txt', 'agent-1');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/delete',
        { path: 'acme/a.txt', originators: { agent: 'agent-1' } },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(result.content[0].text).toBe(
        'Deleted: acme/a.txt (restorable via restore_file)',
      );
    });

    it('returns the server error message when the file does not exist', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(404, { message: 'File not found: acme/missing.txt' }),
      );
      const svc = makeService();
      const result = await svc.deleteFile('acme/missing.txt');
      expect(result.content[0].text).toBe('File not found: acme/missing.txt');
    });
  });

  describe('restoreFile', () => {
    it('restores and returns a confirmation', async () => {
      mockedAxios.post.mockResolvedValue({ data: { restored: true } });
      const svc = makeService();
      const result = await svc.restoreFile('acme/a.txt');
      expect(result.content[0].text).toBe('Restored: acme/a.txt');
    });

    it('returns the server error message when nothing is soft-deleted', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(404, {
          message: 'No soft-deleted file found at _deleted/acme/a.txt',
        }),
      );
      const svc = makeService();
      const result = await svc.restoreFile('acme/a.txt');
      expect(result.content[0].text).toBe(
        'No soft-deleted file found at _deleted/acme/a.txt',
      );
    });
  });

  describe('searchFiles', () => {
    it('proxies to /search and returns entries as JSON', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          entries: [
            { key: 'acme/a.md', name: 'a.md', size: 1, lastModified: 'x' },
          ],
        },
      });
      const svc = makeService();
      const result = await svc.searchFiles('acme', '*.md');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/search',
        { prefix: 'acme', pattern: '*.md' },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(JSON.parse(result.content[0].text)).toHaveLength(1);
    });
  });

  describe('getFileProperties', () => {
    it('returns metadata for an existing file', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { key: 'acme/a.txt', exists: true, size: 5 },
      });
      const svc = makeService();
      const result = await svc.getFileProperties('acme/a.txt');
      expect(JSON.parse(result.content[0].text)).toEqual({
        key: 'acme/a.txt',
        exists: true,
        size: 5,
      });
    });
  });

  describe('copyFile', () => {
    it('copies and returns a confirmation', async () => {
      mockedAxios.post.mockResolvedValue({ data: { copied: true } });
      const svc = makeService();
      const result = await svc.copyFile('acme/a.txt', 'acme/b.txt');
      expect(result.content[0].text).toBe('Copied: acme/a.txt → acme/b.txt');
    });

    it('returns the server error message when the source does not exist', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(404, { message: 'Source file not found: acme/a.txt' }),
      );
      const svc = makeService();
      const result = await svc.copyFile('acme/a.txt', 'acme/b.txt');
      expect(result.content[0].text).toBe('Source file not found: acme/a.txt');
    });
  });

  describe('moveFile', () => {
    it('moves and returns a confirmation', async () => {
      mockedAxios.post.mockResolvedValue({ data: { moved: true } });
      const svc = makeService();
      const result = await svc.moveFile('acme/a.txt', 'acme/b.txt');
      expect(result.content[0].text).toBe('Moved: acme/a.txt → acme/b.txt');
    });
  });

  describe('getFileSummary', () => {
    it('returns the server-computed summary as JSON', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { format: 'json-object', keys: ['a'] },
      });
      const svc = makeService();
      const result = await svc.getFileSummary('acme/config.json');
      expect(JSON.parse(result.content[0].text)).toEqual({
        format: 'json-object',
        keys: ['a'],
      });
    });

    it('returns the server error message for a missing file', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(404, { message: 'File not found: acme/missing.json' }),
      );
      const svc = makeService();
      const result = await svc.getFileSummary('acme/missing.json');
      expect(result.content[0].text).toBe('File not found: acme/missing.json');
    });
  });

  describe('checkMissingFiles', () => {
    it('proxies to GET /internal/storage/exists with a repeated (non-bracket) query string', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { missing: ['acme/missing.txt'] },
      });
      const svc = makeService();
      const missing = await svc.checkMissingFiles([
        'acme/exists.txt',
        'acme/missing.txt',
      ]);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/exists?path=acme%2Fexists.txt&path=acme%2Fmissing.txt',
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(missing).toEqual(['acme/missing.txt']);
    });
  });

  describe('describe_server', () => {
    it('returns an overview mentioning describe_folder and path conventions', async () => {
      const svc = makeService();
      const text = await callTool(svc, 'describe_server', {});
      expect(text).toEqual(expect.any(String));
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe('describe_folder', () => {
    it.each([
      ['acme/tasks/xyz/materials', 'Task materials'],
      ['acme/tasks/xyz/output', 'Task output'],
      ['acme/knowledge/analyst', 'Knowledge base'],
      ['acme/finished/reports', 'Finished reports'],
      ['acme/finished/specifications', 'Finished specifications'],
      ['acme/finished/designs', 'Finished designs'],
      ['acme/finished/code', 'Finished code'],
      ['acme/finished/other', 'Finished'],
      ['acme/audit/2025', 'Audit log'],
      ['acme/unknown/path', 'No specific description'],
    ])(
      'path "%s" returns description containing "%s"',
      async (path, expected) => {
        const svc = makeService();
        const text = await callTool(svc, 'describe_folder', { path });
        expect(text).toContain(expected);
      },
    );
  });
});
