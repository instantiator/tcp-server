import {
  AuditEventType,
  EmbeddingService,
  TcpCompany,
  TcpRole,
  AuditClientService,
  KnowledgeRetrievalService,
  ToolResult,
  ok,
  registerDescribeServer,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
} from '@tcp/shared';
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

/**
 * Composition guidance for the `query` argument of both semantic-search tools
 * (`recall` and `search_knowledge`). Reaches the model as the parameter's
 * JSON Schema description, so it is the one place an agent is told *how* to
 * phrase a search rather than merely that it can.
 *
 * Retrieval embeds the query as a whole and ranks chunks by cosine
 * similarity against the indexed prose, so a query that reads like the
 * passage being looked for scores higher than a keyword list — measurably so:
 * on a real corpus a bare "shelves" scored 0.49 against the very chunk that a
 * full "How do I put up shelves?" scored 0.61 on.
 */
const SEMANTIC_QUERY_GUIDANCE =
  'What to look for, phrased as a natural-language question or descriptive ' +
  'sentence — "how do I mount a shelf on a plasterboard wall?", not a bare ' +
  'keyword like "shelves". This is semantic similarity, not keyword matching: ' +
  'fuller phrasing that reads like the passage you expect to find scores ' +
  'better, so include the domain terms the source material would itself use. ' +
  'Search one topic per call — for several topics, call this tool once each ' +
  'rather than combining them into a single query. If a search returns ' +
  'nothing useful, retry with a rephrasing that reads more like the wording ' +
  'of the material, rather than with fewer words.';

/** Replaces `{{key}}` placeholders in a template string. */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => vars[key] ?? '',
  );
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
    private readonly knowledge: KnowledgeRetrievalService,
    private readonly audit: AuditClientService,
    private readonly config: ConfigService,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Resolves the human-readable name to record against an audit event.
   *
   * The audit trail denormalises the role *name* so history stays readable
   * after a role is renamed or deleted; the tools receive only a `roleId`, so
   * it has to be looked up. Falls back to `'agent'` — the convention the other
   * MCP services already use — when the role no longer exists.
   */
  private async auditRoleName(roleId: string): Promise<string> {
    const role = await this.roleRepo.findOne({
      where: { id: roleId as UUID },
      select: { name: true },
    });
    return role?.name ?? 'agent';
  }

  /** Creates and returns a configured McpServer with all memory tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'tcp-mcp-memory', version: '1.0.0' });
    this.registerDescribeServer(server);
    this.registerSemanticSearchTool(
      server,
      'recall',
      memoryToolDescriptions.recall,
      'The role ID whose memory to search.',
      (companyId, roleId, query, topK) =>
        this.hybridSearch(companyId, roleId, query, topK),
    );
    this.registerRemember(server);
    this.registerSemanticSearchTool(
      server,
      'search_knowledge',
      memoryToolDescriptions.search_knowledge,
      'The role ID whose knowledge base to search.',
      (companyId, roleId, query, topK) =>
        this.knowledgeSearch(companyId, roleId, query, topK),
    );
    return server;
  }

  private registerDescribeServer(server: McpServer): void {
    registerDescribeServer(
      server,
      memoryToolDescriptions.describe_server,
      memoryPrompts.describe_server,
    );
  }

  /**
   * Registers one of the two semantic-search tools.
   *
   * They differ only in name, description, the `roleId` hint and which search
   * runs; the schema, the `top_k` default, the audit row and the result
   * envelope are identical, so neither can drift from the other.
   */
  private registerSemanticSearchTool(
    server: McpServer,
    tool: 'recall' | 'search_knowledge',
    description: string,
    roleIdDescription: string,
    search: (
      companyId: string,
      roleId: string,
      query: string,
      topK: number,
    ) => Promise<string>,
  ): void {
    server.registerTool(
      tool,
      {
        description,
        inputSchema: {
          roleId: z.uuid().describe(roleIdDescription),
          companyId: z
            .uuid()
            .describe('The company ID (used to load embedding config).'),
          query: z.string().describe(SEMANTIC_QUERY_GUIDANCE),
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
        const result = await search(companyId, roleId, query, k);
        this.audit.record(
          companyId,
          await this.auditRoleName(roleId),
          null,
          AuditEventType.ToolCall,
          { tool, query, top_k: k },
        );
        return ok(result);
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
          await this.auditRoleName(roleId),
          agentId ?? null,
          AuditEventType.ToolCall,
          { tool: 'remember' },
        );
        return { content: [{ type: 'text', text }] };
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

    const chunks = await this.knowledge.retrieve(
      roleId as UUID,
      companyId as UUID,
      query,
      embeddingConfig,
      topK,
    );

    return this.formatResults(
      chunks.map((chunk) => ({
        id: chunk.id,
        source: 'knowledge' as const,
        path: chunk.documentPath,
        content: chunk.content,
        similarity: chunk.similarity,
      })),
    );
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
