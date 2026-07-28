import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource } from 'typeorm';

/**
 * The knowledge-base question tcp-agent asks that is specific to running an
 * agent loop. Retrieval itself is shared — see {@link KnowledgeRetrievalService}.
 */
@Injectable()
export class AgentRagService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Whether the role has any indexed knowledge — its own chunks or its
   * company's shared (`roleId IS NULL`) chunks. A cheap indexed existence
   * check (no embedding call), used to decide whether to offer the knowledge
   * (memory) service and run RAG retrieval at all: a role with an empty
   * knowledge base gets neither, saving turns and tokens.
   */
  async hasKnowledge(roleId: UUID, companyId: UUID): Promise<boolean> {
    const rows = await this.dataSource.query<{ exists: boolean }[]>(
      `SELECT EXISTS (
         SELECT 1 FROM knowledge_chunk
         WHERE ("roleId" = $1) OR ("roleId" IS NULL AND "companyId" = $2)
       ) AS exists`,
      [roleId, companyId],
    );
    return rows[0]?.exists ?? false;
  }
}
