import { AuditEventType, AuditClientService } from '@lcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { storagePrompts } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';

/** Shape of a single entry returned by list/search tools. */
interface FileEntry {
  key: string;
  size: number;
  lastModified: string;
}

/** Properties returned by get_file_properties. */
interface FileProperties {
  key: string;
  exists: boolean;
  size?: number;
  contentType?: string;
  lastModified?: string;
}

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/** Nil UUID used as companyId placeholder when company context is unavailable. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** Prefix under which soft-deleted files are stored. */
const DELETED_PREFIX = '_deleted/';

const MIME_MAP: Record<string, string> = {
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.ts': 'application/typescript',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
};

/**
 * Builds fresh {@link McpServer} instances pre-loaded with all storage tools.
 * A new server is created per request so state is never shared across sessions.
 * Tool handlers are public methods so integration tests can call them directly.
 */
@Injectable()
export class StorageToolsService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly config: ConfigService,
    private readonly audit: AuditClientService,
  ) {
    const endpoint =
      this.config.get<string>('MINIO_ENDPOINT') ?? 'http://localhost:9000';
    const accessKeyId =
      this.config.get<string>('MINIO_ACCESS_KEY') ?? 'minioadmin';
    const secretAccessKey =
      this.config.get<string>('MINIO_SECRET_KEY') ?? 'minioadmin';
    this.bucket = this.config.get<string>('MINIO_BUCKET') ?? 'lcp';

    this.s3 = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }

  /** Creates and returns a configured McpServer with all storage tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'lcp-mcp-storage', version: '1.0.0' });

    this.registerDescribeServer(server);
    this.registerDescribeFolder(server);
    this.registerListFiles(server);
    this.registerReadFile(server);
    this.registerWriteFile(server);
    this.registerDeleteFile(server);
    this.registerRestoreFile(server);
    this.registerSearchFiles(server);
    this.registerGetFileProperties(server);
    this.registerCopyFile(server);
    this.registerMoveFile(server);
    this.registerGetFileSummary(server);

    return server;
  }

  // Tool handlers (public for testability)

  async listFiles(prefix?: string): Promise<ToolResult> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix ?? '',
    });
    const response = await this.s3.send(command);
    const entries: FileEntry[] = (response.Contents ?? [])
      .filter((obj) => !obj.Key?.startsWith(DELETED_PREFIX))
      .map((obj) => ({
        key: obj.Key ?? '',
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? '',
      }));
    return {
      content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
    };
  }

  async readFile(path: string): Promise<ToolResult> {
    const err = this.validatePath(path);
    if (err) return this.textResult(err);

    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      const text = await (
        response.Body as { transformToString: () => Promise<string> }
      ).transformToString();
      return this.textResult(text);
    } catch (e) {
      if (this.isNotFound(e)) return this.textResult(`File not found: ${path}`);
      throw e;
    }
  }

  async writeFile(
    path: string,
    content: string,
    overwrite = false,
  ): Promise<ToolResult> {
    const err = this.validatePath(path);
    if (err) return this.textResult(err);

    if (!overwrite && (await this.objectExists(path))) {
      return this.textResult(
        `File already exists at ${path}. Set overwrite: true to replace it.`,
      );
    }

    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: content,
        ContentType: 'text/plain',
      }),
    );
    this.emitAudit('write_file', path, { overwrite });
    return this.textResult(`Written: ${path}`);
  }

  async deleteFile(path: string): Promise<ToolResult> {
    const err = this.validatePath(path);
    if (err) return this.textResult(err);

    if (!(await this.objectExists(path))) {
      return this.textResult(`File not found: ${path}`);
    }

    // Soft delete: copy to _deleted/ prefix, then remove original
    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${path}`,
        Key: `${DELETED_PREFIX}${path}`,
      }),
    );
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: path }),
    );
    this.emitAudit('delete_file', path, {});
    return this.textResult(`Deleted: ${path} (restorable via restore_file)`);
  }

  async restoreFile(path: string): Promise<ToolResult> {
    const err = this.validatePath(path);
    if (err) return this.textResult(err);

    const deletedKey = `${DELETED_PREFIX}${path}`;
    if (!(await this.objectExists(deletedKey))) {
      return this.textResult(`No soft-deleted file found at ${deletedKey}`);
    }

    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${deletedKey}`,
        Key: path,
      }),
    );
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: deletedKey }),
    );
    this.emitAudit('restore_file', path, {});
    return this.textResult(`Restored: ${path}`);
  }

  async searchFiles(prefix?: string, pattern?: string): Promise<ToolResult> {
    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: prefix ?? '',
    });
    const response = await this.s3.send(command);
    let entries: FileEntry[] = (response.Contents ?? [])
      .filter((obj) => !obj.Key?.startsWith(DELETED_PREFIX))
      .map((obj) => ({
        key: obj.Key ?? '',
        size: obj.Size ?? 0,
        lastModified: obj.LastModified?.toISOString() ?? '',
      }));

    if (pattern) {
      const re = this.globToRegex(pattern);
      entries = entries.filter((e) => re.test(e.key));
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
    };
  }

  async getFileProperties(path: string): Promise<ToolResult> {
    const err = this.validatePath(path);
    if (err) return this.textResult(err);

    try {
      const response = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      const props: FileProperties = {
        key: path,
        exists: true,
        size: response.ContentLength,
        contentType: response.ContentType,
        lastModified: response.LastModified?.toISOString(),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(props, null, 2) }],
      };
    } catch (e) {
      if (this.isNotFound(e)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ key: path, exists: false }),
            },
          ],
        };
      }
      throw e;
    }
  }

  async copyFile(source: string, destination: string): Promise<ToolResult> {
    const srcErr = this.validatePath(source, 'source');
    if (srcErr) return this.textResult(srcErr);
    const dstErr = this.validatePath(destination, 'destination');
    if (dstErr) return this.textResult(dstErr);

    if (!(await this.objectExists(source))) {
      return this.textResult(`Source file not found: ${source}`);
    }

    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${source}`,
        Key: destination,
      }),
    );
    this.emitAudit('copy_file', source, { destination });
    return this.textResult(`Copied: ${source} → ${destination}`);
  }

  async moveFile(source: string, destination: string): Promise<ToolResult> {
    const srcErr = this.validatePath(source, 'source');
    if (srcErr) return this.textResult(srcErr);
    const dstErr = this.validatePath(destination, 'destination');
    if (dstErr) return this.textResult(dstErr);

    if (!(await this.objectExists(source))) {
      return this.textResult(`Source file not found: ${source}`);
    }

    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucket,
        CopySource: `${this.bucket}/${source}`,
        Key: destination,
      }),
    );
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: source }),
    );
    this.emitAudit('move_file', source, { destination });
    return this.textResult(`Moved: ${source} → ${destination}`);
  }

  async getFileSummary(path: string): Promise<ToolResult> {
    const err = this.validatePath(path);
    if (err) return this.textResult(err);

    let content: string;
    let size: number | undefined;

    try {
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      size = head.ContentLength;
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: path }),
      );
      content = await (
        response.Body as { transformToString: () => Promise<string> }
      ).transformToString();
    } catch (e) {
      if (this.isNotFound(e)) return this.textResult(`File not found: ${path}`);
      throw e;
    }

    const summary = this.analyzeContent(path, content, size);
    return {
      content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
    };
  }

  // Private helpers

  private validatePath(path: string, label = 'path'): string | null {
    if (!path || path.includes('..')) {
      return `Invalid ${label}: must be non-empty and must not contain "..".`;
    }
    if (path.startsWith(DELETED_PREFIX)) {
      return `Invalid ${label}: cannot directly access the soft-delete folder.`;
    }
    return null;
  }

  async checkMissingFiles(paths: string[]): Promise<string[]> {
    const results = await Promise.all(
      paths.map(async (p) => ({ path: p, exists: await this.objectExists(p) })),
    );
    return results.filter((r) => !r.exists).map((r) => r.path);
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private isNotFound(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return (
      err.name === 'NoSuchKey' || err.name === 'NotFound' || err.name === '404'
    );
  }

  private textResult(text: string): ToolResult {
    return { content: [{ type: 'text', text }] };
  }

  /** Convert a simple glob pattern (*, ?) to a RegExp. */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
    );
  }

  /**
   * Structural analysis of file content — no LLM required.
   * Returns format-specific metadata based on file extension.
   */
  private analyzeContent(
    path: string,
    content: string,
    size: number | undefined,
  ): Record<string, unknown> {
    const ext = path.includes('.')
      ? '.' + path.split('.').pop()!.toLowerCase()
      : '';
    const base: Record<string, unknown> = {
      path,
      size,
      contentType: MIME_MAP[ext] ?? 'application/octet-stream',
    };

    if (ext === '.json' || ext === '.jsonc') {
      try {
        // Strip // comments for jsonc
        const stripped =
          ext === '.jsonc' ? content.replace(/^\s*\/\/.*$/gm, '') : content;
        const parsed: unknown = JSON.parse(stripped);
        if (Array.isArray(parsed)) {
          base.format = 'json-array';
          base.length = parsed.length;
          if (
            parsed.length > 0 &&
            typeof parsed[0] === 'object' &&
            parsed[0] !== null
          ) {
            base.sampleKeys = Object.keys(parsed[0] as object).slice(0, 10);
          }
        } else if (typeof parsed === 'object' && parsed !== null) {
          base.format = 'json-object';
          base.keys = Object.keys(parsed);
        }
      } catch {
        base.format = 'json-invalid';
      }
      return base;
    }

    if (ext === '.md' || ext === '.mdx') {
      const lines = content.split('\n');
      const fmEnd = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
      const frontmatterKeys =
        fmEnd > 0
          ? lines
              .slice(1, fmEnd)
              .filter((l) => l.includes(':'))
              .map((l) => l.split(':')[0].trim())
          : [];
      const headings = lines
        .filter((l) => /^#{1,6}\s/.test(l))
        .map((l) => {
          const m = l.match(/^(#{1,6})\s+(.+)/);
          return m ? { level: m[1].length, text: m[2].trim() } : null;
        })
        .filter(Boolean);
      base.format = 'markdown';
      base.frontmatterKeys = frontmatterKeys;
      base.headings = headings;
      return base;
    }

    if (ext === '.yaml' || ext === '.yml') {
      const topLevelKeys = content
        .split('\n')
        .filter((l) => /^[a-zA-Z_][a-zA-Z0-9_]*\s*:/.test(l))
        .map((l) => l.split(':')[0].trim());
      base.format = 'yaml';
      base.topLevelKeys = topLevelKeys;
      return base;
    }

    if (ext === '.ts' || ext === '.js' || ext === '.mjs') {
      const declarations: string[] = [];
      const patterns = [
        /^export\s+(?:default\s+)?(?:async\s+)?(?:class|function|interface|type|const|enum)\s+(\w+)/gm,
        /^(?:class|function|interface|type|const|enum)\s+(\w+)/gm,
      ];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          if (m[1] && !declarations.includes(m[1])) declarations.push(m[1]);
        }
      }
      base.format = 'typescript';
      base.declarations = declarations;
      return base;
    }

    base.format = 'text';
    base.lineCount = content.split('\n').length;
    return base;
  }

  private emitAudit(
    tool: string,
    path: string,
    extra: Record<string, unknown>,
  ): void {
    this.audit.record(NIL_UUID, 'storage', null, AuditEventType.ToolCall, {
      tool,
      path,
      ...extra,
    });
  }

  // Server registration

  private registerDescribeServer(server: McpServer): void {
    server.registerTool(
      'describe_server',
      { description: storageToolDescriptions.describe_server },
      (): ToolResult => ({
        content: [{ type: 'text', text: storagePrompts.describe_server }],
      }),
    );
  }

  private registerDescribeFolder(server: McpServer): void {
    server.registerTool(
      'describe_folder',
      {
        description: storageToolDescriptions.describe_folder,
        inputSchema: {
          path: z.string().describe('The folder path prefix to describe.'),
        },
      },
      ({ path }): ToolResult => ({
        content: [{ type: 'text', text: this.describeFolder(path) }],
      }),
    );
  }

  private describeFolder(p: string): string {
    if (p.includes('/tasks/') && p.includes('/materials'))
      return storagePrompts.describe_folder_task_materials;
    if (p.includes('/tasks/') && p.includes('/output'))
      return storagePrompts.describe_folder_task_output;
    if (p.includes('/knowledge/') || p.endsWith('/knowledge'))
      return storagePrompts.describe_folder_knowledge;
    if (p.includes('/finished/reports'))
      return storagePrompts.describe_folder_finished_reports;
    if (p.includes('/finished/specifications'))
      return storagePrompts.describe_folder_finished_specifications;
    if (p.includes('/finished/designs'))
      return storagePrompts.describe_folder_finished_designs;
    if (p.includes('/finished/code'))
      return storagePrompts.describe_folder_finished_code;
    if (p.includes('/finished/other'))
      return storagePrompts.describe_folder_finished_other;
    if (p.includes('/audit/') || p.endsWith('/audit'))
      return storagePrompts.describe_folder_audit;
    return storagePrompts.describe_folder_fallback;
  }

  private registerListFiles(server: McpServer): void {
    server.registerTool(
      'list_files',
      {
        description: storageToolDescriptions.list_files,
        inputSchema: {
          path: z
            .string()
            .optional()
            .describe('Path prefix to list under (default: all files).'),
        },
      },
      ({ path }) => this.listFiles(path),
    );
  }

  private registerReadFile(server: McpServer): void {
    server.registerTool(
      'read_file',
      {
        description: storageToolDescriptions.read_file,
        inputSchema: { path: z.string().describe('The object key to read.') },
      },
      ({ path }) => this.readFile(path),
    );
  }

  private registerWriteFile(server: McpServer): void {
    server.registerTool(
      'write_file',
      {
        description: storageToolDescriptions.write_file,
        inputSchema: {
          path: z.string().describe('The object key to write.'),
          content: z.string().describe('The text content to write.'),
          overwrite: z
            .boolean()
            .optional()
            .describe('Replace an existing file (default: false).'),
        },
      },
      ({ path, content, overwrite }) =>
        this.writeFile(path, content, overwrite ?? false),
    );
  }

  private registerDeleteFile(server: McpServer): void {
    server.registerTool(
      'delete_file',
      {
        description: storageToolDescriptions.delete_file,
        inputSchema: {
          path: z.string().describe('The object key to delete.'),
        },
      },
      ({ path }) => this.deleteFile(path),
    );
  }

  private registerRestoreFile(server: McpServer): void {
    server.registerTool(
      'restore_file',
      {
        description: storageToolDescriptions.restore_file,
        inputSchema: {
          path: z.string().describe('The original object key to restore.'),
        },
      },
      ({ path }) => this.restoreFile(path),
    );
  }

  private registerSearchFiles(server: McpServer): void {
    server.registerTool(
      'search_files',
      {
        description: storageToolDescriptions.search_files,
        inputSchema: {
          prefix: z
            .string()
            .optional()
            .describe('Path prefix to search under.'),
          pattern: z
            .string()
            .optional()
            .describe(
              'Glob pattern to match against full key (supports * and ?).',
            ),
        },
      },
      ({ prefix, pattern }) => this.searchFiles(prefix, pattern),
    );
  }

  private registerGetFileProperties(server: McpServer): void {
    server.registerTool(
      'get_file_properties',
      {
        description: storageToolDescriptions.get_file_properties,
        inputSchema: {
          path: z.string().describe('The object key to inspect.'),
        },
      },
      ({ path }) => this.getFileProperties(path),
    );
  }

  private registerCopyFile(server: McpServer): void {
    server.registerTool(
      'copy_file',
      {
        description: storageToolDescriptions.copy_file,
        inputSchema: {
          source: z.string().describe('The source object key.'),
          destination: z.string().describe('The destination object key.'),
        },
      },
      ({ source, destination }) => this.copyFile(source, destination),
    );
  }

  private registerMoveFile(server: McpServer): void {
    server.registerTool(
      'move_file',
      {
        description: storageToolDescriptions.move_file,
        inputSchema: {
          source: z.string().describe('The source object key.'),
          destination: z.string().describe('The destination object key.'),
        },
      },
      ({ source, destination }) => this.moveFile(source, destination),
    );
  }

  private registerGetFileSummary(server: McpServer): void {
    server.registerTool(
      'get_file_summary',
      {
        description: storageToolDescriptions.get_file_summary,
        inputSchema: {
          path: z.string().describe('The object key to summarise.'),
        },
      },
      ({ path }) => this.getFileSummary(path),
    );
  }
}
