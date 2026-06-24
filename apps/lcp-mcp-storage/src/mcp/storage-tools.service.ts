import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Shape of a single entry returned by the list_files tool. */
interface FileEntry {
  key: string;
  size: number;
  lastModified: string;
}

/** MCP tool result envelope — index signature satisfies the SDK's Zod-inferred type. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

/**
 * Builds fresh {@link McpServer} instances pre-loaded with all storage tools.
 * A new server is created per request so state is never shared across sessions.
 */
@Injectable()
export class StorageToolsService {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
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
      // MinIO requires path-style addressing
      forcePathStyle: true,
    });
  }

  /** Creates and returns a configured McpServer with all storage tools registered. */
  createServer(): McpServer {
    const server = new McpServer({
      name: 'lcp-mcp-storage',
      version: '1.0.0',
    });

    this.registerDescribeServer(server);
    this.registerDescribeFolder(server);
    this.registerListFiles(server);
    this.registerReadFile(server);
    this.registerWriteFile(server);
    this.registerDeleteFile(server);

    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.tool(
      'describe_server',
      'Returns an overview of the storage service and its tools.',
      {},
      (): ToolResult => {
        return {
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
                '- **list_files(path?)** — list files under a path prefix (default: all files)',
                "- **read_file(path)** — read a file's text content",
                '- **write_file(path, content)** — create or overwrite a file',
                '- **delete_file(path)** — permanently delete a file',
                '',
                '### Path conventions',
                'Paths are relative to the bucket root and follow the structure: `{company_slug}/{area}/...`',
                'Do not include a leading slash.',
              ].join('\n'),
            },
          ],
        };
      },
    );
  }

  private registerDescribeFolder(server: McpServer): void {
    server.tool(
      'describe_folder',
      'Explains the purpose of a folder in the storage hierarchy.',
      { path: z.string().describe('The folder path prefix to describe.') },
      ({ path }): ToolResult => {
        const description = this.describeFolder(path);
        return { content: [{ type: 'text', text: description }] };
      },
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
      async ({ path }): Promise<ToolResult> => {
        const command = new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: path ?? '',
        });
        const response = await this.s3.send(command);
        const entries: FileEntry[] = (response.Contents ?? []).map((obj) => ({
          key: obj.Key ?? '',
          size: obj.Size ?? 0,
          lastModified: obj.LastModified?.toISOString() ?? '',
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
        };
      },
    );
  }

  private registerReadFile(server: McpServer): void {
    server.tool(
      'read_file',
      'Reads the text content of a file from the object store.',
      { path: z.string().describe('The object key to read.') },
      async ({ path }): Promise<ToolResult> => {
        try {
          const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: path,
          });
          const response = await this.s3.send(command);
          const body = response.Body;
          if (body === undefined) {
            return {
              content: [{ type: 'text', text: `File not found: ${path}` }],
            };
          }
          // transformToString is available on the SDK's Body type in Node
          const text = await (
            body as { transformToString: () => Promise<string> }
          ).transformToString();
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          const name = err instanceof Error ? err.name : '';
          if (name === 'NoSuchKey' || name === 'NotFound') {
            return {
              content: [{ type: 'text', text: `File not found: ${path}` }],
            };
          }
          throw err;
        }
      },
    );
  }

  private registerWriteFile(server: McpServer): void {
    server.tool(
      'write_file',
      'Creates or overwrites a file in the object store.',
      {
        path: z.string().describe('The object key to write.'),
        content: z.string().describe('The text content to write.'),
      },
      async ({ path, content }): Promise<ToolResult> => {
        if (!path || path.includes('..')) {
          return {
            content: [
              {
                type: 'text',
                text: 'Invalid path: must be non-empty and must not contain "..".',
              },
            ],
          };
        }
        const command = new PutObjectCommand({
          Bucket: this.bucket,
          Key: path,
          Body: content,
          ContentType: 'text/plain',
        });
        await this.s3.send(command);
        return { content: [{ type: 'text', text: `Written: ${path}` }] };
      },
    );
  }

  private registerDeleteFile(server: McpServer): void {
    server.tool(
      'delete_file',
      'Permanently deletes a file from the object store.',
      { path: z.string().describe('The object key to delete.') },
      async ({ path }): Promise<ToolResult> => {
        if (!path || path.includes('..')) {
          return {
            content: [
              {
                type: 'text',
                text: 'Invalid path: must be non-empty and must not contain "..".',
              },
            ],
          };
        }
        const command = new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: path,
        });
        await this.s3.send(command);
        return { content: [{ type: 'text', text: `Deleted: ${path}` }] };
      },
    );
  }
}
