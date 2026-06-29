import {
  CopyObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { AuditClientService } from '@lcp/shared';
import { StorageToolsService } from './storage-tools.service';

jest.mock('@aws-sdk/client-s3', () => {
  const actual =
    jest.requireActual<typeof import('@aws-sdk/client-s3')>(
      '@aws-sdk/client-s3',
    );
  return { ...actual, S3Client: jest.fn() };
});

function makeConfig(): ConfigService {
  return {
    get: jest.fn().mockReturnValue(undefined),
  } as unknown as ConfigService;
}

function makeAudit(): jest.Mocked<AuditClientService> {
  return { record: jest.fn() } as unknown as jest.Mocked<AuditClientService>;
}

function makeBody(text: string) {
  return { transformToString: jest.fn().mockResolvedValue(text) };
}

function makeService(send: jest.Mock) {
  jest
    .mocked(S3Client)
    .mockImplementation(() => ({ send }) as unknown as S3Client);
  return new StorageToolsService(makeConfig(), makeAudit());
}

// Access a registered tool via the MCP server's internal map
async function callTool(
  service: StorageToolsService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const server = service.createServer();
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

describe('StorageToolsService', () => {
  let send: jest.Mock;

  beforeEach(() => {
    send = jest.fn();
  });

  afterEach(() => jest.clearAllMocks());

  // list_files

  describe('list_files', () => {
    it('returns a JSON array of file entries', async () => {
      send.mockResolvedValue({
        Contents: [
          {
            Key: 'acme/tasks/1/output/file.md',
            Size: 100,
            LastModified: new Date('2025-01-01'),
          },
        ],
      });
      const text = await callTool(makeService(send), 'list_files', {
        path: 'acme/',
      });
      const parsed = JSON.parse(text) as { key: string }[];
      expect(parsed[0].key).toBe('acme/tasks/1/output/file.md');
    });

    it('excludes soft-deleted files from results', async () => {
      send.mockResolvedValue({
        Contents: [
          { Key: '_deleted/acme/old.md', Size: 50, LastModified: new Date() },
          { Key: 'acme/current.md', Size: 50, LastModified: new Date() },
        ],
      });
      const text = await callTool(makeService(send), 'list_files', {});
      const parsed = JSON.parse(text) as { key: string }[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].key).toBe('acme/current.md');
    });
  });

  // read_file

  describe('read_file', () => {
    it('returns the file content as text', async () => {
      send.mockResolvedValue({ Body: makeBody('# Hello') });
      const text = await callTool(makeService(send), 'read_file', {
        path: 'acme/doc.md',
      });
      expect(text).toBe('# Hello');
    });

    it('returns "File not found" message for missing files', async () => {
      const err = Object.assign(new Error(), { name: 'NoSuchKey' });
      send.mockRejectedValue(err);
      const text = await callTool(makeService(send), 'read_file', {
        path: 'acme/missing.md',
      });
      expect(text).toContain('not found');
    });

    it('rejects paths containing ".."', async () => {
      const text = await callTool(makeService(send), 'read_file', {
        path: '../etc/passwd',
      });
      expect(text).toContain('Invalid');
      expect(send).not.toHaveBeenCalled();
    });
  });

  // write_file

  describe('write_file', () => {
    it('writes the file and returns a confirmation', async () => {
      // HeadObject throws NotFound (file does not exist) → overwrite check passes → PutObject succeeds
      const notFound = Object.assign(new Error(), { name: 'NotFound' });
      send.mockRejectedValueOnce(notFound).mockResolvedValue({});
      const text = await callTool(makeService(send), 'write_file', {
        path: 'acme/new.md',
        content: 'hello',
      });
      expect(text).toContain('Written');
      expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('refuses to overwrite when overwrite is false and file exists', async () => {
      // First send = HeadObject (file exists), would not reach PutObject
      send.mockResolvedValue({});
      const text = await callTool(makeService(send), 'write_file', {
        path: 'acme/existing.md',
        content: 'new content',
        overwrite: false,
      });
      expect(text).toContain('already exists');
      expect(send).not.toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });

    it('overwrites when overwrite is true', async () => {
      // HeadObject → file exists, PutObject → success
      send.mockResolvedValue({});
      const text = await callTool(makeService(send), 'write_file', {
        path: 'acme/existing.md',
        content: 'new content',
        overwrite: true,
      });
      expect(text).toContain('Written');
      expect(send).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });
  });

  // delete_file / restore_file

  describe('delete_file', () => {
    it('soft-deletes: copies to _deleted/ then removes original', async () => {
      // HeadObject (exists) → CopyObject → DeleteObject
      send.mockResolvedValue({});
      const text = await callTool(makeService(send), 'delete_file', {
        path: 'acme/doc.md',
      });
      expect(text).toContain('Deleted');
      expect(text).toContain('restorable');
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
      expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });

    it('returns "File not found" when the file does not exist', async () => {
      const notFound = Object.assign(new Error(), { name: 'NotFound' });
      send.mockRejectedValue(notFound);
      const text = await callTool(makeService(send), 'delete_file', {
        path: 'acme/gone.md',
      });
      expect(text).toContain('not found');
    });

    it('rejects paths containing ".."', async () => {
      const text = await callTool(makeService(send), 'delete_file', {
        path: '../secret',
      });
      expect(text).toContain('Invalid');
    });
  });

  describe('restore_file', () => {
    it('restores a soft-deleted file', async () => {
      // HeadObject (_deleted/ key exists) → CopyObject → DeleteObject
      send.mockResolvedValue({});
      const text = await callTool(makeService(send), 'restore_file', {
        path: 'acme/doc.md',
      });
      expect(text).toContain('Restored');
    });

    it('returns error message when no soft-deleted file exists', async () => {
      const notFound = Object.assign(new Error(), { name: 'NotFound' });
      send.mockRejectedValue(notFound);
      const text = await callTool(makeService(send), 'restore_file', {
        path: 'acme/doc.md',
      });
      expect(text).toContain('No soft-deleted file found');
    });
  });

  // search_files

  describe('search_files', () => {
    it('returns all files when no pattern is given', async () => {
      send.mockResolvedValue({
        Contents: [
          { Key: 'acme/a.md', Size: 1, LastModified: new Date() },
          { Key: 'acme/b.ts', Size: 2, LastModified: new Date() },
        ],
      });
      const text = await callTool(makeService(send), 'search_files', {
        prefix: 'acme/',
      });
      const parsed = JSON.parse(text) as { key: string }[];
      expect(parsed).toHaveLength(2);
    });

    it('filters results using glob pattern', async () => {
      send.mockResolvedValue({
        Contents: [
          { Key: 'acme/report.md', Size: 1, LastModified: new Date() },
          { Key: 'acme/data.json', Size: 2, LastModified: new Date() },
        ],
      });
      const text = await callTool(makeService(send), 'search_files', {
        prefix: 'acme/',
        pattern: '*.md',
      });
      const parsed = JSON.parse(text) as { key: string }[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0].key).toBe('acme/report.md');
    });
  });

  // get_file_properties

  describe('get_file_properties', () => {
    it('returns metadata for an existing file', async () => {
      send.mockResolvedValue({
        ContentLength: 512,
        ContentType: 'text/markdown',
        LastModified: new Date('2025-06-01'),
      });
      const text = await callTool(makeService(send), 'get_file_properties', {
        path: 'acme/doc.md',
      });
      const parsed = JSON.parse(text) as { exists: boolean; size: number };
      expect(parsed.exists).toBe(true);
      expect(parsed.size).toBe(512);
    });

    it('returns { exists: false } for a missing file', async () => {
      const err = Object.assign(new Error(), { name: 'NotFound' });
      send.mockRejectedValue(err);
      const text = await callTool(makeService(send), 'get_file_properties', {
        path: 'acme/missing.md',
      });
      const parsed = JSON.parse(text) as { exists: boolean };
      expect(parsed.exists).toBe(false);
    });
  });

  // copy_file / move_file

  describe('copy_file', () => {
    it('copies a file and returns confirmation', async () => {
      send.mockResolvedValue({});
      const text = await callTool(makeService(send), 'copy_file', {
        source: 'acme/src.md',
        destination: 'acme/dst.md',
      });
      expect(text).toContain('Copied');
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
    });

    it('returns error when source does not exist', async () => {
      const notFound = Object.assign(new Error(), { name: 'NotFound' });
      send.mockRejectedValue(notFound);
      const text = await callTool(makeService(send), 'copy_file', {
        source: 'acme/missing.md',
        destination: 'acme/dst.md',
      });
      expect(text).toContain('Source file not found');
    });

    it('rejects ".." in source path', async () => {
      const text = await callTool(makeService(send), 'copy_file', {
        source: '../etc/passwd',
        destination: 'acme/dst.md',
      });
      expect(text).toContain('Invalid source');
    });
  });

  describe('move_file', () => {
    it('copies then deletes and returns confirmation', async () => {
      send.mockResolvedValue({});
      const text = await callTool(makeService(send), 'move_file', {
        source: 'acme/old.md',
        destination: 'acme/new.md',
      });
      expect(text).toContain('Moved');
      expect(send).toHaveBeenCalledWith(expect.any(CopyObjectCommand));
      expect(send).toHaveBeenCalledWith(expect.any(DeleteObjectCommand));
    });
  });

  // get_file_summary

  describe('get_file_summary', () => {
    it('returns JSON summary with format=json-object for a JSON file', async () => {
      send.mockResolvedValue({
        ContentLength: 30,
        Body: makeBody('{"name":"acme","count":5}'),
      });
      const text = await callTool(makeService(send), 'get_file_summary', {
        path: 'acme/config.json',
      });
      const parsed = JSON.parse(text) as { format: string; keys: string[] };
      expect(parsed.format).toBe('json-object');
      expect(parsed.keys).toContain('name');
    });

    it('returns format=json-array and element count for a JSON array', async () => {
      send.mockResolvedValue({ ContentLength: 10, Body: makeBody('[1,2,3]') });
      const text = await callTool(makeService(send), 'get_file_summary', {
        path: 'acme/list.json',
      });
      const parsed = JSON.parse(text) as { format: string; length: number };
      expect(parsed.format).toBe('json-array');
      expect(parsed.length).toBe(3);
    });

    it('returns headings for a markdown file', async () => {
      const md = '# Title\n\nSome text.\n\n## Section\n\nMore text.';
      send.mockResolvedValue({ ContentLength: md.length, Body: makeBody(md) });
      const text = await callTool(makeService(send), 'get_file_summary', {
        path: 'acme/doc.md',
      });
      const parsed = JSON.parse(text) as { headings: { text: string }[] };
      expect(parsed.headings.map((h) => h.text)).toContain('Title');
      expect(parsed.headings.map((h) => h.text)).toContain('Section');
    });

    it('returns "File not found" for a missing file', async () => {
      const err = Object.assign(new Error(), { name: 'NoSuchKey' });
      send.mockRejectedValue(err);
      const text = await callTool(makeService(send), 'get_file_summary', {
        path: 'acme/gone.md',
      });
      expect(text).toContain('not found');
    });
  });

  // describe_server

  describe('describe_server', () => {
    it('returns overview text containing key tool names', async () => {
      const text = await callTool(makeService(send), 'describe_server', {});
      expect(text).toContain('Storage Service');
      expect(text).toContain('list_files');
      expect(text).toContain('write_file');
    });
  });

  // describe_folder

  describe('describe_folder', () => {
    const cases: [string, string][] = [
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
    ];

    it.each(cases)(
      'path "%s" returns description containing "%s"',
      async (path, expected) => {
        const text = await callTool(makeService(send), 'describe_folder', {
          path,
        });
        expect(text).toContain(expected);
      },
    );
  });
});
