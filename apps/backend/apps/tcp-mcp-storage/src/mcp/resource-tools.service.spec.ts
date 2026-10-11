import { InternalApiClient } from '@tcp/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ResourceToolsService } from './resource-tools.service';
import { StorageApiService } from './storage-api.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const BASE = 'http://tcp-server:3000';
const SCOPE_URL = `${BASE}/internal/agent/agent-1/storage-scope`;
const LIVE = 'acme/resources/';
const STEP = 'acme/tasks/t1/assignments/0/completed/resources/';
const DRAFT = 'acme/tasks/t1/assignments/1/working/resources/';

type Mode = 'draft' | 'direct' | 'read-only';

interface Resources {
  mode: Mode;
  readPrefixes: string[];
  writePrefix: string | null;
}

const DRAFT_SCOPE: Resources = {
  mode: 'draft',
  readPrefixes: [DRAFT, STEP, LIVE],
  writePrefix: DRAFT,
};
const DIRECT_SCOPE: Resources = {
  mode: 'direct',
  readPrefixes: [LIVE],
  writePrefix: LIVE,
};
const READ_ONLY_SCOPE: Resources = {
  mode: 'read-only',
  readPrefixes: [LIVE],
  writePrefix: null,
};

function makeApi(): StorageApiService {
  const config = {
    getOrThrow: jest.fn(
      (k: string) =>
        ({ TCP_SERVER_URL: BASE, INTERNAL_API_KEY: 'secret-key' })[k],
    ),
  } as unknown as ConfigService;
  return new StorageApiService(new InternalApiClient(config));
}

function axiosError(status: number, body: unknown): Error {
  const err = new Error('request failed');
  Object.assign(err, {
    isAxiosError: true,
    response: { status, data: body },
  });
  return err;
}

/** An in-memory object store behind the faked `/internal/storage/*` actions. */
let store: Map<string, string>;

function actionOf(url: string): string {
  return url.slice(`${BASE}/internal/storage/`.length);
}

function fakeStorage(url: string, body: Record<string, string>): unknown {
  switch (actionOf(url)) {
    case 'list':
      return {
        entries: [...store.keys()]
          .filter((key) => key.startsWith(body.prefix))
          .map((key) => ({ key, name: key, size: 1, lastModified: 'x' })),
      };
    case 'properties':
      return { key: body.path, exists: store.has(body.path) };
    case 'read': {
      const content = store.get(body.path);
      if (content === undefined) {
        throw axiosError(404, { message: `File not found: ${body.path}` });
      }
      return { content };
    }
    case 'write':
      store.set(body.path, body.content);
      return {};
    case 'append': {
      const created = !store.has(body.path);
      store.set(body.path, (store.get(body.path) ?? '') + body.content);
      return { created };
    }
    case 'replace': {
      const text = store.get(body.path) ?? '';
      if (!text.includes(body.find)) {
        throw axiosError(422, { message: 'String not found' });
      }
      const parts = text.split(body.find);
      store.set(body.path, parts.join(body.replace));
      return { count: parts.length - 1 };
    }
    case 'copy':
      store.set(body.destination, store.get(body.source) ?? '');
      return {};
    default:
      throw new Error(`unexpected action ${url}`);
  }
}

function useScope(resources: Resources): void {
  mockedAxios.get.mockImplementation((url: string) =>
    url === SCOPE_URL
      ? Promise.resolve({
          data: {
            mode: 'implement',
            readOnly: false,
            companyPrefix: 'acme/',
            workingPrefix: DRAFT.replace('resources/', ''),
            materials: [],
            resources,
          },
        })
      : Promise.reject(new Error(`unexpected GET ${url}`)),
  );
}

/** Calls a registered tool directly, bypassing the transport layer. */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  new ResourceToolsService(makeApi()).register(server);
  const tools = (server as unknown as { _registeredTools: unknown })
    ._registeredTools as Record<
    string,
    {
      handler: (
        args: Record<string, unknown>,
      ) => Promise<{ content: { text: string }[] }>;
    }
  >;
  const result = await tools[name].handler({ agentId: 'agent-1', ...args });
  return result.content[0].text;
}

/** The POST bodies sent for one storage action. */
function posts(action: string): Record<string, unknown>[] {
  return mockedAxios.post.mock.calls
    .filter(([url]) => url === `${BASE}/internal/storage/${action}`)
    .map(([, body]) => body as Record<string, unknown>);
}

describe('ResourceToolsService', () => {
  beforeEach(() => {
    store = new Map();
    mockedAxios.isAxiosError.mockImplementation(
      (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
    );
    // Deferred, so the fake's thrown errors surface as rejections like axios's.
    mockedAxios.post.mockImplementation((url: string, body: unknown) =>
      Promise.resolve().then(() => ({
        data: fakeStorage(url, body as Record<string, string>),
      })),
    );
    useScope(DRAFT_SCOPE);
  });

  afterEach(() => jest.clearAllMocks());

  describe('path rules', () => {
    it.each([
      ['read_resource', { path: '../x.md' }, "can't contain '..'"],
      ['read_resource', { path: '' }, 'A resource path is required'],
      ['read_resource', { path: 'invoices/' }, 'is a folder'],
      ['write_resource', { path: 'a/../b.md', content: 'x' }, "'..'"],
      ['list_resources', { path: '../' }, "can't contain '..'"],
    ])(
      '%s %j reaches the model as text, with no storage call',
      async (tool, args, text) => {
        expect(await callTool(tool, args)).toContain(text);
        expect(mockedAxios.post).not.toHaveBeenCalled();
      },
    );

    it('accepts a full key copied from a listing', async () => {
      store.set(`${LIVE}price-list.md`, 'prices');
      expect(
        await callTool('read_resource', {
          path: 'acme/resources/price-list.md',
        }),
      ).toBe('prices');
    });
  });

  describe('read_resource', () => {
    it('falls through the layers: own draft, then an earlier step, then live', async () => {
      store.set(`${LIVE}a.md`, 'live a');
      store.set(`${STEP}a.md`, 'step a');
      store.set(`${DRAFT}a.md`, 'draft a');
      store.set(`${LIVE}b.md`, 'live b');
      store.set(`${STEP}b.md`, 'step b');
      store.set(`${LIVE}c.md`, 'live c');
      expect(await callTool('read_resource', { path: 'a.md' })).toBe('draft a');
      expect(await callTool('read_resource', { path: 'b.md' })).toBe('step b');
      expect(await callTool('read_resource', { path: 'c.md' })).toBe('live c');
    });

    it("lists the folder's files when the file is missing", async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}invoices/INV-2.md`, 'x');
      expect(
        await callTool('read_resource', { path: 'invoices/INV-9.md' }),
      ).toBe(
        "There is no resource 'invoices/INV-9.md'. Files in 'invoices/': INV-1.md, INV-2.md.",
      );
    });

    it('names the top folder as resources/ when the file is missing there', async () => {
      store.set(`${LIVE}price-list.md`, 'x');
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      expect(await callTool('read_resource', { path: 'prices.md' })).toBe(
        "There is no resource 'prices.md'. Files in 'resources/': invoices/, price-list.md.",
      );
    });

    it('names a missing sub-folder under an existing one', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      expect(
        await callTool('read_resource', { path: 'invoices/2026/a.md' }),
      ).toContain("There is no folder 'invoices/2026/'.");
    });

    it('shows the tree from the deepest existing folder when the folder is missing', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}invoices/README.md`, '# Invoices we sent\n');
      const text = await callTool('read_resource', {
        path: 'invoices/2026/q1/a.md',
      });
      expect(text).toBe(
        [
          "There is no folder 'invoices/2026/q1/'.",
          'invoices/ — Invoices we sent',
          '  INV-1.md',
          '  README.md',
        ].join('\n'),
      );
    });

    it('describes a folder passed as a file path', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}invoices/old/a.md`, 'x');
      expect(await callTool('read_resource', { path: 'invoices' })).toBe(
        "'invoices' is a folder. Its files: old/, INV-1.md.",
      );
    });

    it('suggests the same name with another extension', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}other/INV-1.txt`, 'x');
      expect(
        await callTool('read_resource', { path: 'invoices/INV-1.txt' }),
      ).toContain("Did you mean 'invoices/INV-1.md'?");
    });

    it('suggests the same file name in another folder, naming at most 3', async () => {
      for (const f of ['a', 'b', 'c', 'd']) store.set(`${LIVE}${f}/x.md`, 'x');
      store.set(`${LIVE}top.md`, 'x');
      const text = await callTool('read_resource', { path: 'x.md' });
      expect(text).toContain("Did you mean 'a/x.md' or 'b/x.md' or 'c/x.md'?");
      expect(text).not.toContain('d/x.md');
    });

    it('prefers the same folder over the same name elsewhere', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}other/INV-1.txt`, 'x');
      const text = await callTool('read_resource', {
        path: 'invoices/INV-1.txt',
      });
      expect(text).not.toContain('other/INV-1.txt');
    });

    it('refuses a binary file that exists, without reading it', async () => {
      store.set(`${LIVE}brochure.PDF`, 'bytes');
      expect(await callTool('read_resource', { path: 'brochure.PDF' })).toBe(
        "'brochure.PDF' is a binary file and can't be read as text.",
      );
      expect(posts('read')).toHaveLength(0);
    });

    it('reports a missing binary file as not found', async () => {
      expect(
        await callTool('read_resource', { path: 'brochure.pdf' }),
      ).toContain("There is no resource 'brochure.pdf'.");
    });

    it('relays a server error as text', async () => {
      store.set(`${LIVE}a.md`, 'x');
      mockedAxios.post.mockRejectedValue(axiosError(500, { message: 'down' }));
      expect(await callTool('read_resource', { path: 'a.md' })).toBe('down');
    });
  });

  describe('list_resources', () => {
    it('says there are none, and offers to create one only when writable', async () => {
      expect(await callTool('list_resources', {})).toBe(
        "There are no company resources yet. Create one with write_resource, e.g. 'price-list.md'.",
      );
      useScope(READ_ONLY_SCOPE);
      expect(await callTool('list_resources', {})).toBe(
        'There are no company resources yet.',
      );
    });

    it('shows purposes, draft markers, and folders before files', async () => {
      store.set(`${LIVE}README.md`, '\n## Everything we keep\n');
      store.set(`${LIVE}zebra.md`, 'x');
      store.set(
        `${LIVE}invoices/README.md`,
        "# Invoices we've sent, one per file.",
      );
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}invoices/2026/a.md`, 'x');
      store.set(`${DRAFT}invoices/INV-2.md`, 'x');
      store.set(`${LIVE}archive/old.md`, 'x');
      expect(await callTool('list_resources', {})).toBe(
        [
          'resources/ — Everything we keep',
          '  archive/',
          '    old.md',
          "  invoices/ — Invoices we've sent, one per file.",
          '    2026/',
          '      a.md',
          '    INV-1.md',
          '    INV-2.md (draft)',
          '    README.md',
          '  README.md',
          '  zebra.md',
        ].join('\n'),
      );
    });

    it('lists a sub-folder on its own', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      store.set(`${LIVE}price-list.md`, 'x');
      expect(await callTool('list_resources', { path: 'invoices' })).toBe(
        'invoices/\n  INV-1.md',
      );
    });

    it('shows the tree from the deepest existing folder for a missing folder', async () => {
      store.set(`${LIVE}invoices/INV-1.md`, 'x');
      expect(await callTool('list_resources', { path: 'invoices/2027' })).toBe(
        "There is no folder 'invoices/2027/'.\ninvoices/\n  INV-1.md",
      );
    });

    it('caps the tree at 200 lines and says how many it left out', async () => {
      for (let i = 0; i < 250; i++) {
        store.set(`${LIVE}f${String(i).padStart(3, '0')}.md`, 'x');
      }
      const lines = (await callTool('list_resources', {})).split('\n');
      expect(lines).toHaveLength(201);
      // 250 files plus the top line, 200 shown.
      expect(lines[200]).toBe('…and 51 more. Pass a folder path to see it.');
    });

    it('reads one full list per layer so a big folder is not cut off', async () => {
      store.set(`${LIVE}a.md`, 'x');
      await callTool('list_resources', {});
      expect(posts('list')).toEqual([
        { prefix: DRAFT, all: true },
        { prefix: STEP, all: true },
        { prefix: LIVE, all: true },
      ]);
    });
  });

  describe('write_resource', () => {
    it('is refused with the read-only text when the mode may not change resources', async () => {
      useScope(READ_ONLY_SCOPE);
      expect(
        await callTool('write_resource', { path: 'a.md', content: 'x' }),
      ).toBe(
        'Company resources are read-only in this mode. Use list_resources and read_resource to look at them.',
      );
      expect(posts('write')).toHaveLength(0);
    });

    it('creates in the draft layer and says it is a draft', async () => {
      const text = await callTool('write_resource', {
        path: 'price-list.md',
        content: 'prices',
      });
      expect(text).toBe(
        "Created resource 'price-list.md'. It's a draft, applied to the company's resources when the task succeeds.",
      );
      expect(posts('write')).toEqual([
        {
          path: `${DRAFT}price-list.md`,
          content: 'prices',
          overwrite: true,
          originators: { agent: 'agent-1' },
        },
      ]);
    });

    it('reports Replaced when any layer already has the file', async () => {
      store.set(`${LIVE}price-list.md`, 'old');
      expect(
        await callTool('write_resource', {
          path: 'price-list.md',
          content: 'new',
        }),
      ).toContain("Replaced resource 'price-list.md'.");
    });

    it('writes straight to the live folder in direct mode, with no draft note', async () => {
      useScope(DIRECT_SCOPE);
      const text = await callTool('write_resource', {
        path: 'price-list.md',
        content: 'prices',
      });
      expect(text).toBe("Created resource 'price-list.md'.");
      expect(store.get(`${LIVE}price-list.md`)).toBe('prices');
    });

    it('relays a validation hint from the server', async () => {
      mockedAxios.post.mockImplementation((url: string) =>
        actionOf(url) === 'write'
          ? Promise.reject(
              axiosError(422, { errors: [{ llmHint: 'Fix the table.' }] }),
            )
          : Promise.resolve({ data: { exists: false, entries: [] } }),
      );
      expect(
        await callTool('write_resource', { path: 'a.md', content: 'x' }),
      ).toContain('Fix the table.');
    });

    describe('new folder hint', () => {
      it('appears once for the first file in a new folder', async () => {
        const first = await callTool('write_resource', {
          path: 'invoices/INV-1.md',
          content: 'x',
        });
        expect(first).toContain(
          "New folder 'invoices/'. Add a one-line purpose note with write_resource('invoices/README.md', …).",
        );
        const second = await callTool('write_resource', {
          path: 'invoices/INV-2.md',
          content: 'x',
        });
        expect(second).not.toContain('New folder');
      });

      it('does not appear when the folder already has files', async () => {
        store.set(`${LIVE}invoices/INV-0.md`, 'x');
        expect(
          await callTool('write_resource', {
            path: 'invoices/INV-1.md',
            content: 'x',
          }),
        ).not.toContain('New folder');
      });

      it('does not appear for the top folder or when writing the README itself', async () => {
        expect(
          await callTool('write_resource', { path: 'a.md', content: 'x' }),
        ).not.toContain('New folder');
        expect(
          await callTool('write_resource', {
            path: 'fresh/README.md',
            content: '# Fresh',
          }),
        ).not.toContain('New folder');
      });
    });
  });

  describe('append_resource', () => {
    it('copies the live file into the draft first, then appends', async () => {
      store.set(`${LIVE}notes.md`, 'one\n');
      const text = await callTool('append_resource', {
        path: 'notes.md',
        content: 'two\n',
      });
      expect(posts('copy')).toEqual([
        { source: `${LIVE}notes.md`, destination: `${DRAFT}notes.md` },
      ]);
      expect(store.get(`${DRAFT}notes.md`)).toBe('one\ntwo\n');
      expect(store.get(`${LIVE}notes.md`)).toBe('one\n');
      expect(text).toContain("Appended to resource 'notes.md'.");
      expect(text).toContain("It's a draft");
    });

    it('does not copy once the draft has the file', async () => {
      store.set(`${LIVE}notes.md`, 'one\n');
      store.set(`${DRAFT}notes.md`, 'draft\n');
      await callTool('append_resource', { path: 'notes.md', content: 'x' });
      expect(posts('copy')).toHaveLength(0);
    });

    it('does not copy in direct mode', async () => {
      useScope(DIRECT_SCOPE);
      store.set(`${LIVE}notes.md`, 'one\n');
      const text = await callTool('append_resource', {
        path: 'notes.md',
        content: 'two\n',
      });
      expect(posts('copy')).toHaveLength(0);
      expect(store.get(`${LIVE}notes.md`)).toBe('one\ntwo\n');
      expect(text).toBe("Appended to resource 'notes.md'.");
    });

    it('starts the new text on a new line when the file has no trailing newline', async () => {
      useScope(DIRECT_SCOPE);
      store.set(`${LIVE}prices.md`, 'Call-out: £45');
      await callTool('append_resource', {
        path: 'prices.md',
        content: 'Hourly: £30',
      });
      expect(store.get(`${LIVE}prices.md`)).toBe('Call-out: £45\nHourly: £30');
    });

    it('creates the file when no layer has it', async () => {
      expect(
        await callTool('append_resource', { path: 'new.md', content: 'x' }),
      ).toContain("Created resource 'new.md'.");
      expect(posts('copy')).toHaveLength(0);
    });

    it('is refused when read-only', async () => {
      useScope(READ_ONLY_SCOPE);
      expect(
        await callTool('append_resource', { path: 'a.md', content: 'x' }),
      ).toContain('read-only');
      expect(posts('append')).toHaveLength(0);
    });
  });

  describe('replace_in_resource', () => {
    it('copies a step file into the draft first, then replaces', async () => {
      store.set(`${STEP}list.md`, 'cat cat dog');
      const text = await callTool('replace_in_resource', {
        path: 'list.md',
        find: 'cat',
        replace: 'cow',
      });
      expect(posts('copy')).toEqual([
        { source: `${STEP}list.md`, destination: `${DRAFT}list.md` },
      ]);
      expect(store.get(`${DRAFT}list.md`)).toBe('cow cow dog');
      expect(text).toContain("Replaced 2 occurrence(s) in resource 'list.md'.");
    });

    it('does not copy in direct mode', async () => {
      useScope(DIRECT_SCOPE);
      store.set(`${LIVE}list.md`, 'cat');
      await callTool('replace_in_resource', {
        path: 'list.md',
        find: 'cat',
        replace: 'cow',
      });
      expect(posts('copy')).toHaveLength(0);
      expect(store.get(`${LIVE}list.md`)).toBe('cow');
    });

    it('returns the not-found text for a missing file, without calling replace', async () => {
      store.set(`${LIVE}price-list.md`, 'x');
      const text = await callTool('replace_in_resource', {
        path: 'price-lists.md',
        find: 'a',
        replace: 'b',
      });
      expect(text).toContain("There is no resource 'price-lists.md'.");
      expect(posts('replace')).toHaveLength(0);
      expect(posts('copy')).toHaveLength(0);
    });

    it('relays an error when the string is not found', async () => {
      store.set(`${LIVE}list.md`, 'cat');
      expect(
        await callTool('replace_in_resource', {
          path: 'list.md',
          find: 'zzz',
          replace: 'b',
        }),
      ).toBe('String not found');
    });
  });
});
