import {
  AuditEventType,
  EmbeddingService,
  EpisodicMemory,
  LlmConfig,
  TcpCompany,
  TcpRole,
  resolveEmbeddingConfig,
  resolveEnvEmbeddingConfig,
} from '@tcp/shared';
import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import pgvector from 'pgvector';
import { DataSource, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import type {
  CreateMemoryDto,
  MemoryDto,
  MemoryListDto,
  UpdateMemoryDto,
} from './dto/memory.dto';

/** How many memories a list returns, newest first. */
export const MEMORY_LIST_CAP = 500;

/** Shown when a company has no embedding model to embed a memory with. */
const NO_EMBEDDING_MODEL =
  "This company has no embedding model, so memories can't be saved or searched.";

/**
 * People's view of a role's memories (002.06): list, add, reword and delete.
 * Agents write through the memory MCP server instead; both embed what they
 * store, so a memory a person adds is recalled like any other.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly embedding: EmbeddingService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    @InjectRepository(EpisodicMemory)
    private readonly memoryRepo: Repository<EpisodicMemory>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /** The role's newest memories, and whether it can take new ones. */
  async list(roleId: UUID): Promise<MemoryListDto> {
    const { role, embeddingConfig } = await this.resolve(roleId);
    const rows = await this.memoryRepo.find({
      where: { roleId: role.id, companyId: role.companyId },
      order: { updatedAt: 'DESC' },
      take: MEMORY_LIST_CAP + 1,
    });
    return {
      memories: rows.slice(0, MEMORY_LIST_CAP).map(toDto),
      truncated: rows.length > MEMORY_LIST_CAP,
      canWrite: embeddingConfig !== null,
    };
  }

  /** @throws {@link UnprocessableEntityException} without an embedding model. */
  async create(
    roleId: UUID,
    body: CreateMemoryDto,
    userId: string | null,
  ): Promise<MemoryDto> {
    const { role, embeddingConfig } = await this.resolve(roleId);
    const vector = await this.embed(embeddingConfig, body.content);
    const [{ id }] = await this.dataSource.query<{ id: UUID }[]>(
      `INSERT INTO episodic_memory ("companyId", "roleId", content, tags, embedding)
       VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5::vector)
       RETURNING id`,
      [
        role.companyId,
        role.id,
        body.content,
        JSON.stringify(cleanTags(body.tags)),
        vector,
      ],
    );
    await this.changed(role, userId, 'created', id);
    return toDto(await this.memoryRepo.findOneByOrFail({ id }));
  }

  /**
   * Changes the fields given. New content is embedded again, so recall
   * finds the memory by what it says now.
   *
   * @throws {@link NotFoundException} when the memory isn't this role's.
   * @throws {@link UnprocessableEntityException} for new content without an embedding model.
   */
  async update(
    roleId: UUID,
    id: UUID,
    body: UpdateMemoryDto,
    userId: string | null,
  ): Promise<MemoryDto> {
    const { role, embeddingConfig } = await this.resolve(roleId);
    const memory = await this.findOwned(role, id);
    const content = body.content ?? memory.content;
    const tags = body.tags ? cleanTags(body.tags) : (memory.tags ?? []);
    const vector =
      content === memory.content
        ? null
        : await this.embed(embeddingConfig, content);
    await this.dataSource.query(
      `UPDATE episodic_memory
       SET content = $2, tags = $3::jsonb,
           embedding = COALESCE($4::vector, embedding),
           version = version + 1, "updatedAt" = now()
       WHERE id = $1::uuid`,
      [id, content, JSON.stringify(tags), vector],
    );
    await this.changed(role, userId, 'updated', id);
    return toDto(await this.memoryRepo.findOneByOrFail({ id }));
  }

  /** @throws {@link NotFoundException} when the memory isn't this role's. */
  async remove(roleId: UUID, id: UUID, userId: string | null): Promise<void> {
    const { role } = await this.resolve(roleId);
    await this.memoryRepo.remove(await this.findOwned(role, id));
    await this.changed(role, userId, 'deleted', id);
  }

  /** The role and the embedding config its memories use (company, then env). */
  private async resolve(
    roleId: UUID,
  ): Promise<{ role: TcpRole; embeddingConfig: LlmConfig | null }> {
    const role = await this.roleRepo.findOneBy({ id: roleId });
    if (!role) throw new NotFoundException(`Role ${roleId} not found`);
    const company = await this.companyRepo.findOneBy({ id: role.companyId });
    return {
      role,
      embeddingConfig:
        resolveEmbeddingConfig(
          company,
          resolveEnvEmbeddingConfig(this.config),
        ) ?? null,
    };
  }

  /** A memory by id, only if it belongs to the role (and so its company). */
  private async findOwned(role: TcpRole, id: UUID): Promise<EpisodicMemory> {
    const memory = await this.memoryRepo.findOneBy({
      id,
      roleId: role.id,
      companyId: role.companyId,
    });
    if (!memory) throw new NotFoundException(`Memory ${id} not found`);
    return memory;
  }

  private async embed(
    config: LlmConfig | null,
    content: string,
  ): Promise<string> {
    if (!config) throw new UnprocessableEntityException(NO_EMBEDDING_MODEL);
    const [vector] = await this.embedding.embedTexts(config, [content]);
    return pgvector.toSql(vector) as string;
  }

  /** Audits a person's change; the company stream sends it on as a memory signal. */
  private changed(
    role: TcpRole,
    userId: string | null,
    action: 'created' | 'updated' | 'deleted',
    memoryId: UUID,
  ): Promise<void> {
    return this.audit.record(
      role.companyId,
      'user',
      null,
      AuditEventType.StateChange,
      { source: 'memory', action, roleId: role.id, memoryId, userId },
    );
  }
}

/** Trimmed, non-empty, without repeats. */
function cleanTags(tags: string[] | undefined): string[] {
  return [...new Set((tags ?? []).map((t) => t.trim()).filter(Boolean))];
}

function toDto(memory: EpisodicMemory): MemoryDto {
  return {
    id: memory.id,
    content: memory.content,
    tags: memory.tags ?? [],
    agentId: memory.agentId,
    version: memory.version,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}
