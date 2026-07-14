import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { StorageToolsService } from './storage-tools.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const SCOPE_URL = 'http://lcp-server:3000/internal/agent/agent-1/storage-scope';

interface Scope {
  mode: 'plan' | 'implement' | 'qa';
  readOnly: boolean;
  workingPrefix: string;
  materials: { name: string; key: string | null; inlineText?: string }[];
}

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

/** Routes the scope GET to `scope`; any other GET falls through to a default. */
function mockScope(scope: Partial<Scope>): void {
  const full: Scope = {
    mode: 'implement',
    readOnly: false,
    workingPrefix: 'acme/tasks/t1/assignments/0/working/',
    materials: [],
    ...scope,
  };
  mockedAxios.get.mockImplementation((url: string) => {
    if (url === SCOPE_URL) return Promise.resolve({ data: full });
    return Promise.resolve({ data: { missing: [] } });
  });
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

  // Read-only exploration ------------------------------------------------

  describe('listFiles', () => {
    it('proxies to POST /internal/storage/list and returns entries as JSON', async () => {
      mockedAxios.post.mockResolvedValue({
        data: {
          entries: [{ key: 'a', name: 'a', size: 1, lastModified: 'x' }],
        },
      });
      const result = await makeService().listFiles('acme');
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
      const result = await makeService().readFile('acme/a.txt');
      expect(result.content[0].text).toBe('hello');
    });

    it('returns the server error message for a missing file', async () => {
      mockedAxios.post.mockRejectedValue(
        axiosError(404, { message: 'File not found: acme/missing.txt' }),
      );
      const result = await makeService().readFile('acme/missing.txt');
      expect(result.content[0].text).toBe('File not found: acme/missing.txt');
    });
  });

  describe('getFileSummary', () => {
    it('returns the server-computed summary as JSON', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { format: 'json-object', keys: ['a'] },
      });
      const result = await makeService().getFileSummary('acme/config.json');
      expect(JSON.parse(result.content[0].text)).toEqual({
        format: 'json-object',
        keys: ['a'],
      });
    });
  });

  describe('checkMissingFiles', () => {
    it('proxies to GET /internal/storage/exists with a repeated (non-bracket) query string', async () => {
      mockedAxios.get.mockResolvedValue({
        data: { missing: ['acme/missing.txt'] },
      });
      const missing = await makeService().checkMissingFiles([
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

  // Assignment-scoped working files --------------------------------------

  describe('working-file scope resolution', () => {
    it('lists under the working prefix from the resolved scope', async () => {
      mockScope({ workingPrefix: 'acme/tasks/t1/assignments/2/working/' });
      mockedAxios.post.mockResolvedValue({ data: { entries: [] } });
      await makeService().listWorkingFiles('agent-1');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/list',
        { prefix: 'acme/tasks/t1/assignments/2/working/' },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
    });

    it('resolves a filename to a key under the working prefix (orphan)', async () => {
      mockScope({ workingPrefix: 'acme/assignments/a9/working/' });
      mockedAxios.post.mockResolvedValue({ data: { content: 'x' } });
      await makeService().readWorkingFile('agent-1', 'notes/plan.md');
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/read',
        { path: 'acme/assignments/a9/working/notes/plan.md' },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
    });
  });

  describe('appendWorkingFile', () => {
    it('reports a create when the file did not exist', async () => {
      mockScope({});
      mockedAxios.post.mockResolvedValue({ data: { created: true } });
      const result = await makeService().appendWorkingFile(
        'agent-1',
        'out.md',
        '# hi',
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/append',
        {
          path: 'acme/tasks/t1/assignments/0/working/out.md',
          content: '# hi',
          originators: { agent: 'agent-1' },
        },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(result.content[0].text).toBe('Created working file: out.md');
    });

    it('reports an append when the file already existed', async () => {
      mockScope({});
      mockedAxios.post.mockResolvedValue({ data: { created: false } });
      const result = await makeService().appendWorkingFile(
        'agent-1',
        'out.md',
        'more',
      );
      expect(result.content[0].text).toBe('Appended to working file: out.md');
    });

    it('relays a 422 validation failure via errors[].llmHint', async () => {
      mockScope({});
      mockedAxios.post.mockRejectedValue(
        axiosError(422, {
          message: 'Document failed validation',
          errors: [{ llmHint: 'Fix the JSON syntax.' }],
        }),
      );
      const result = await makeService().appendWorkingFile(
        'agent-1',
        'out.json',
        '{bad',
      );
      expect(result.content[0].text).toBe('Fix the JSON syntax.');
    });
  });

  describe('replaceInWorkingFile', () => {
    it('reports the replacement count', async () => {
      mockScope({});
      mockedAxios.post.mockResolvedValue({ data: { count: 3 } });
      const result = await makeService().replaceInWorkingFile(
        'agent-1',
        'out.md',
        'foo',
        'bar',
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/replace',
        {
          path: 'acme/tasks/t1/assignments/0/working/out.md',
          find: 'foo',
          replace: 'bar',
          originators: { agent: 'agent-1' },
        },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(result.content[0].text).toBe(
        'Replaced 3 occurrence(s) in working file: out.md',
      );
    });

    it('relays a zero-occurrence error from the server', async () => {
      mockScope({});
      mockedAxios.post.mockRejectedValue(
        axiosError(400, {
          message: 'The string "foo" does not occur in ...; nothing replaced.',
        }),
      );
      const result = await makeService().replaceInWorkingFile(
        'agent-1',
        'out.md',
        'foo',
        'bar',
      );
      expect(result.content[0].text).toContain('does not occur');
    });
  });

  describe('filename safety', () => {
    it('rejects a parent-traversal filename and never calls the append endpoint', async () => {
      mockScope({});
      const result = await makeService().appendWorkingFile(
        'agent-1',
        '../secrets.txt',
        'x',
      );
      expect(result.content[0].text).toContain("'..'");
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('rejects an absolute filename', async () => {
      mockScope({});
      const result = await makeService().readWorkingFile(
        'agent-1',
        '/etc/passwd',
      );
      expect(result.content[0].text).toContain('relative');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });
  });

  describe('read-only scope refuses mutating tools', () => {
    it.each([
      ['appendWorkingFile', 'append_working_file', ['agent-1', 'f.md', 'x']],
      [
        'replaceInWorkingFile',
        'replace_in_working_file',
        ['agent-1', 'f.md', 'a', 'b'],
      ],
      ['deleteWorkingFile', 'delete_working_file', ['agent-1', 'f.md']],
      ['restoreWorkingFile', 'restore_working_file', ['agent-1', 'f.md']],
      ['renameWorkingFile', 'rename_working_file', ['agent-1', 'a.md', 'b.md']],
    ] as const)(
      '%s names the tool and the read tools',
      async (method, tool, args) => {
        mockScope({ mode: 'qa', readOnly: true });
        const svc = makeService();
        const result = await (
          svc[method] as (
            ...a: unknown[]
          ) => Promise<{ content: { text: string }[] }>
        )(...args);
        expect(result.content[0].text).toContain(tool);
        expect(result.content[0].text).toContain('read-only');
        expect(result.content[0].text).toContain('read_working_file');
        expect(result.content[0].text).not.toContain('mode:');
        expect(mockedAxios.post).not.toHaveBeenCalled();
      },
    );

    it('still allows reading in qa mode', async () => {
      mockScope({ mode: 'qa', readOnly: true });
      mockedAxios.post.mockResolvedValue({ data: { content: 'reviewed' } });
      const result = await makeService().readWorkingFile('agent-1', 'f.md');
      expect(result.content[0].text).toBe('reviewed');
    });
  });

  // Assignment-scoped materials ------------------------------------------

  describe('materials', () => {
    it('lists storage-backed and inline materials with their kind', async () => {
      mockScope({
        materials: [
          { name: 'brief.md', key: 'acme/tasks/t1/materials/brief.md' },
          { name: 'inline-1', key: null, inlineText: 'do the thing' },
        ],
      });
      const result = await makeService().listMaterialFiles('agent-1');
      expect(JSON.parse(result.content[0].text)).toEqual([
        { name: 'brief.md', kind: 'file' },
        { name: 'inline-1', kind: 'inline-text' },
      ]);
    });

    it('reads an inline-text material as its literal content, no HTTP read', async () => {
      mockScope({
        materials: [{ name: 'inline-1', key: null, inlineText: 'literal' }],
      });
      const result = await makeService().readMaterialFile(
        'agent-1',
        'inline-1',
      );
      expect(result.content[0].text).toBe('literal');
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it('reads a storage-backed material via its resolved key', async () => {
      mockScope({
        materials: [
          { name: 'brief.md', key: 'acme/tasks/t1/materials/brief.md' },
        ],
      });
      mockedAxios.post.mockResolvedValue({ data: { content: 'the brief' } });
      const result = await makeService().readMaterialFile(
        'agent-1',
        'brief.md',
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        'http://lcp-server:3000/internal/storage/read',
        { path: 'acme/tasks/t1/materials/brief.md' },
        { headers: { 'X-Internal-Api-Key': 'secret-key' } },
      );
      expect(result.content[0].text).toBe('the brief');
    });

    it('reports an unknown material name', async () => {
      mockScope({ materials: [] });
      const result = await makeService().readMaterialFile('agent-1', 'nope.md');
      expect(result.content[0].text).toContain("No material named 'nope.md'");
    });
  });
});
