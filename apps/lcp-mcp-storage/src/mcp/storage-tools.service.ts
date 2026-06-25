import { AuditEventType } from '@lcp/shared';
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
import { AuditClientService } from '../audit/audit-client.service';

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

/** Extension → content-type map used by get_file_summary. */
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

  // ─── Tool handlers (public for testability) ───────────────────────────────

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

  // ─── Private helpers ──────────────────────────────────────────────────────

  private validatePath(path: string, label = 'path'): string | null {
    if (!path || path.includes('..')) {
      return `Invalid ${label}: must be non-empty and must not contain "..".`;
    }
    if (path.startsWith(DELETED_PREFIX)) {
      return `Invalid ${label}: cannot directly access the soft-delete folder.`;
    }
    return null;
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

  // ─── Server registration ──────────────────────────────────────────────────

  private registerDescribeServer(server: McpServer): void {
    server.tool(
      'describe_server',
      'Returns an overview of the storage service and its tools.',
      {},
      (): ToolResult => ({
        content: [
          {
            type: 'text',
            text: [
              '## Storage Service',
              '',
              'Provides read/write access to the shared MinIO object store, organised per the ADR-007 folder layout.',
              'Call `describe_folder` with any path prefix to learn what that folder is for and what it should contain.',
              '',
              '### Tools',
              '- **describe_server** — this overview',
              '- **describe_folder(path)** — explain the purpose of a folder in the storage hierarchy',
              '- **list_files(path?)** — list files under a path prefix (excludes soft-deleted files)',
              "- **read_file(path)** — read a file's text content",
              '- **write_file(path, content, overwrite?)** — create or overwrite a file (overwrite defaults to false)',
              '- **delete_file(path)** — soft-delete a file (moved to `_deleted/` prefix; restorable)',
              '- **restore_file(path)** — restore a soft-deleted file',
              '- **search_files(prefix?, pattern?)** — list files matching a glob pattern under a prefix',
              '- **get_file_properties(path)** — get file metadata (size, content type, last modified)',
              '- **copy_file(source, destination)** — copy a file to a new path',
              '- **move_file(source, destination)** — move (rename) a file',
              '- **get_file_summary(path)** — structural analysis of a file (headings, keys, declarations)',
              '',
              '### Path conventions',
              'Paths are relative to the bucket root and follow the structure: `{company_slug}/{area}/...`',
              'Do not include a leading slash.',
              '',
              '### Soft delete',
              'Deleted files are moved to `_deleted/{original_path}` and can be restored with `restore_file`.',
            ].join('\n'),
          },
        ],
      }),
    );
  }

  private registerDescribeFolder(server: McpServer): void {
    server.tool(
      'describe_folder',
      'Explains the purpose of a folder in the storage hierarchy.',
      { path: z.string().describe('The folder path prefix to describe.') },
      ({ path }): ToolResult => ({
        content: [{ type: 'text', text: this.describeFolder(path) }],
      }),
    );
  }

  private describeFolder(path: string): string {
    if (path.includes('/tasks/') && path.includes('/materials')) {
      return '**Task materials** — User-submitted inputs for this task (briefs, data files, reference documents). Read-only after task creation.';
    }
    if (path.includes('/tasks/') && path.includes('/output')) {
      return '**Task output** — Files created during task execution. This is your working area: write intermediate results and final artefacts here before review.';
    }
    if (path.includes('/knowledge/') || path.endsWith('/knowledge')) {
      return '**Knowledge base** — OKF Markdown source documents for RAG indexing. Managed by the `store-role-documents` CLI command. Treat as read-only from within an agent.';
    }
    if (path.includes('/finished/reports')) {
      return '**Finished reports** — Reviewed, stable report artefacts accessible to all agents and stakeholders.';
    }
    if (path.includes('/finished/specifications')) {
      return '**Finished specifications** — Reviewed technical or functional specifications.';
    }
    if (path.includes('/finished/designs')) {
      return '**Finished designs** — Reviewed design documents (wireframes, architecture diagrams, etc.).';
    }
    if (path.includes('/finished/code')) {
      return '**Finished code** — Reviewed and signed-off code artefacts.';
    }
    if (path.includes('/finished/other')) {
      return '**Finished (other)** — Stable artefacts that do not fit a named category.';
    }
    if (path.includes('/audit/') || path.endsWith('/audit')) {
      return '**Audit log** — Append-only JSONL audit entries written by the system. Do not modify.';
    }
    return 'No specific description is available for this path. Use `list_files` to explore its contents.';
  }

  private registerListFiles(server: McpServer): void {
    server.tool(
      'list_files',
      'Lists files under a path prefix in the object store.',
      {
        path: z
          .string()
          .optional()
          .describe('Path prefix to list under (default: all files).'),
      },
      ({ path }) => this.listFiles(path),
    );
  }

  private registerReadFile(server: McpServer): void {
    server.tool(
      'read_file',
      'Reads the text content of a file from the object store.',
      { path: z.string().describe('The object key to read.') },
      ({ path }) => this.readFile(path),
    );
  }

  private registerWriteFile(server: McpServer): void {
    server.tool(
      'write_file',
      'Creates a file in the object store. Set overwrite: true to replace an existing file.',
      {
        path: z.string().describe('The object key to write.'),
        content: z.string().describe('The text content to write.'),
        overwrite: z
          .boolean()
          .optional()
          .describe('Replace an existing file (default: false).'),
      },
      ({ path, content, overwrite }) =>
        this.writeFile(path, content, overwrite ?? false),
    );
  }

  private registerDeleteFile(server: McpServer): void {
    server.tool(
      'delete_file',
      'Soft-deletes a file by moving it to the _deleted/ prefix. Use restore_file to undo.',
      { path: z.string().describe('The object key to delete.') },
      ({ path }) => this.deleteFile(path),
    );
  }

  private registerRestoreFile(server: McpServer): void {
    server.tool(
      'restore_file',
      'Restores a soft-deleted file from the _deleted/ prefix back to its original path.',
      { path: z.string().describe('The original object key to restore.') },
      ({ path }) => this.restoreFile(path),
    );
  }

  private registerSearchFiles(server: McpServer): void {
    server.tool(
      'search_files',
      'Lists files matching a glob pattern under a path prefix.',
      {
        prefix: z.string().optional().describe('Path prefix to search under.'),
        pattern: z
          .string()
          .optional()
          .describe(
            'Glob pattern to match against full key (supports * and ?).',
          ),
      },
      ({ prefix, pattern }) => this.searchFiles(prefix, pattern),
    );
  }

  private registerGetFileProperties(server: McpServer): void {
    server.tool(
      'get_file_properties',
      'Returns metadata for a file: size, content type, last modified, and whether it exists.',
      { path: z.string().describe('The object key to inspect.') },
      ({ path }) => this.getFileProperties(path),
    );
  }

  private registerCopyFile(server: McpServer): void {
    server.tool(
      'copy_file',
      'Copies a file to a new path, leaving the original in place.',
      {
        source: z.string().describe('The source object key.'),
        destination: z.string().describe('The destination object key.'),
      },
      ({ source, destination }) => this.copyFile(source, destination),
    );
  }

  private registerMoveFile(server: McpServer): void {
    server.tool(
      'move_file',
      'Moves (renames) a file to a new path, removing the original.',
      {
        source: z.string().describe('The source object key.'),
        destination: z.string().describe('The destination object key.'),
      },
      ({ source, destination }) => this.moveFile(source, destination),
    );
  }

  private registerGetFileSummary(server: McpServer): void {
    server.tool(
      'get_file_summary',
      'Returns a structural summary of a file without reading its full content: headings, top-level keys, or top-level declarations depending on format.',
      { path: z.string().describe('The object key to summarise.') },
      ({ path }) => this.getFileSummary(path),
    );
  }
}
