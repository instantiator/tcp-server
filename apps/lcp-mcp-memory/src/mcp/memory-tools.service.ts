import {
  AuditEventType,
  EmbeddingService,
  LcpCompany,
  AuditClientService,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
} from '@lcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UUID } from 'crypto';
import pgvector from 'pgvector';
import { DataSource, Repository } from 'typeorm';
import { z } from 'zod';
import { memoryPrompts } from '../memory-prompts';
import { memoryToolDescriptions } from '../memory-tool-descriptions';

/** Replaces `{{key}}` placeholders in a template string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? '',
  );
}

/** MCP tool result envelope. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

interface MemoryRow {
  id: UUID;
  source: 'knowledge' | 'episodic';
  path: string;
  content: string;
  similarity: number;
}

/**
 * Builds fresh {@link McpServer} instances with real memory tools backed by pgvector.
 * Each request gets its own server instance — no shared state across sessions.
 */
@Injectable()
export class MemoryToolsService {
  private readonly logger = new Logger(MemoryToolsService.name);

  constructor(
    private readonly embedding: EmbeddingService,
    private readonly audit: AuditClientService,
    private readonly config: ConfigService,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** Creates and returns a configured McpServer with all memory tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'lcp-mcp-memory', version: '1.0.0' });
    this.registerDescribeServer(server);
    this.registerRecall(server);
    this.registerRemember(server);
    this.registerSearchKnowledge(server);
    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    server.registerTool(
      'describe_server',
      { description: memoryToolDescriptions.describe_server },
      (): ToolResult => ({
        content: [
          {
            type: 'text',
            text: memoryPrompts.describe_server,
          },
        ],
      }),
    );
  }

  private registerRecall(server: McpServer): void {
    server.registerTool(
      'recall',
      {
        description: memoryToolDescriptions.recall,
        inputSchema: {
          roleId: z.uuid().describe('The role ID whose memory to search.'),
          companyId: z
            .uuid()
            .describe('The company ID (used to load embedding config).'),
          query: z.string().describe('The search query.'),
          top_k: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Maximum results (default 5).'),
        },
      },
      async ({ roleId, companyId, query, top_k }): Promise<ToolResult> => {
        const k = top_k ?? 5;
        const result = await this.hybridSearch(companyId, roleId, query, k);
        this.audit.record(companyId, roleId, null, AuditEventType.ToolCall, {
          tool: 'recall',
          query,
          top_k: k,
        });
        return { content: [{ type: 'text', text: result }] };
      },
    );
  }

  private registerRemember(server: McpServer): void {
    server.registerTool(
      'remember',
      {
        description: memoryToolDescriptions.remember,
        inputSchema: {
          roleId: z.uuid().describe('The role ID to store this memory under.'),
          companyId: z
            .uuid()
            .describe('The company ID (used to load embedding config).'),
          content: z.string().describe('The content to remember.'),
          agentId: z
            .uuid()
            .optional()
            .describe('The agent storing the memory.'),
          tags: z
            .array(z.string())
            .optional()
            .describe('Optional classification tags.'),
        },
      },
      async ({
        roleId,
        companyId,
        content,
        agentId,
        tags,
      }): Promise<ToolResult> => {
        const text = await this.storeMemory(
          companyId,
          roleId,
          content,
          agentId ?? null,
          tags ?? null,
        );
        this.audit.record(
          companyId,
          roleId,
          agentId ?? null,
          AuditEventType.ToolCall,
          { tool: 'remember' },
        );
        return { content: [{ type: 'text', text }] };
      },
    );
  }

  private registerSearchKnowledge(server: McpServer): void {
    server.registerTool(
      'search_knowledge',
      {
        description: memoryToolDescriptions.search_knowledge,
        inputSchema: {
          roleId: z
            .uuid()
            .describe('The role ID whose knowledge base to search.'),
          companyId: z
            .uuid()
            .describe('The company ID (used to load embedding config).'),
          query: z.string().describe('The search query.'),
          top_k: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Maximum results (default 5).'),
        },
      },
      async ({ roleId, companyId, query, top_k }): Promise<ToolResult> => {
        const k = top_k ?? 5;
        const result = await this.knowledgeSearch(companyId, roleId, query, k);
        this.audit.record(companyId, roleId, null, AuditEventType.ToolCall, {
          tool: 'search_knowledge',
          query,
          top_k: k,
        });
        return { content: [{ type: 'text', text: result }] };
      },
    );
  }

  async hybridSearch(
    companyId: string,
    roleId: string,
    query: string,
    topK: number,
  ): Promise<string> {
    const embeddingConfig = await this.loadEmbeddingConfig(companyId);
    if (!embeddingConfig) return memoryPrompts.no_embedding_config;

    const queryVector = await this.embedding.embedQuery(embeddingConfig, query);
    const vec = pgvector.toSql(queryVector);

    const rows = await this.dataSource.query<MemoryRow[]>(
      `SELECT * FROM (
         SELECT 'knowledge' AS source, id::text, "documentPath" AS path, content,
                1 - (embedding <=> $1::vector) AS similarity
         FROM knowledge_chunk
         WHERE (("roleId" = $2::uuid) OR ("roleId" IS NULL AND "companyId" = $3::uuid))
           AND embedding IS NOT NULL
         UNION ALL
         SELECT 'episodic', id::text, '' AS path, content,
                1 - (embedding <=> $1::vector) AS similarity
         FROM episodic_memory
         WHERE "roleId" = $2::uuid AND embedding IS NOT NULL
       ) combined
       WHERE similarity >= 0.5
       ORDER BY similarity DESC
       LIMIT $4`,
      [vec, roleId, companyId, topK],
    );

    return this.formatResults(rows);
  }

  async knowledgeSearch(
    companyId: string,
    roleId: string,
    query: string,
    topK: number,
  ): Promise<string> {
    const embeddingConfig = await this.loadEmbeddingConfig(companyId);
    if (!embeddingConfig) return memoryPrompts.no_embedding_config;

    const queryVector = await this.embedding.embedQuery(embeddingConfig, query);

    const rows = await this.dataSource.query<MemoryRow[]>(
      `SELECT 'knowledge' AS source, id::text, "documentPath" AS path, content,
              1 - (embedding <=> $1::vector) AS similarity
       FROM knowledge_chunk
       WHERE (("roleId" = $2::uuid) OR ("roleId" IS NULL AND "companyId" = $3::uuid))
         AND embedding IS NOT NULL AND 1 - (embedding <=> $1::vector) >= 0.5
       ORDER BY similarity DESC
       LIMIT $4`,
      [pgvector.toSql(queryVector), roleId, companyId, topK],
    );

    return this.formatResults(rows);
  }

  async storeMemory(
    companyId: string,
    roleId: string,
    content: string,
    agentId: string | null,
    tags: string[] | null,
  ): Promise<string> {
    const embeddingConfig = await this.loadEmbeddingConfig(companyId);
    if (!embeddingConfig) return memoryPrompts.no_embedding_config_store;

    const vector = await this.embedding.embedTexts(embeddingConfig, [content]);
    const vec = pgvector.toSql(vector[0]);

    const rows = await this.dataSource.query<{ id: UUID }[]>(
      `INSERT INTO episodic_memory ("companyId", "roleId", "agentId", content, tags, embedding)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::vector)
       RETURNING id`,
      [
        companyId,
        roleId,
        agentId,
        content,
        tags ? JSON.stringify(tags) : null,
        vec,
      ],
    );

    this.logger.debug(
      `Stored episodic memory ${rows[0].id} for role ${roleId}`,
    );
    return interpolate(memoryPrompts.memory_stored, { id: rows[0].id });
  }

  private async loadEmbeddingConfig(companyId: string) {
    const company = await this.companyRepo.findOne({
      where: { id: companyId as UUID },
    });
    return (
      resolveEmbeddingConfig(company, resolveEnvEmbeddingConfig(this.config)) ??
      null
    );
  }

  private formatResults(rows: MemoryRow[]): string {
    if (rows.length === 0) return memoryPrompts.no_results;

    return rows
      .map((r, i) => {
        const header =
          r.source === 'knowledge'
            ? `[${i + 1}] source: knowledge | similarity: ${Number(r.similarity).toFixed(2)} | path: ${r.path}`
            : `[${i + 1}] source: episodic  | similarity: ${Number(r.similarity).toFixed(2)}`;
        return `${header}\n"${r.content.slice(0, 500)}${r.content.length > 500 ? '…' : ''}"`;
      })
      .join('\n\n');
  }
}
