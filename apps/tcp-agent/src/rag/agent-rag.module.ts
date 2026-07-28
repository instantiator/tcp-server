import { EmbeddingService, KnowledgeRetrievalService } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { AgentRagService } from './agent-rag.service';

/**
 * Provides tcp-agent's knowledge-base access: shared
 * {@link KnowledgeRetrievalService} for retrieval, {@link AgentRagService} for
 * the agent-specific "is there anything indexed at all?" check. Does not
 * include indexing — that is handled by tcp-server.
 */
@Module({
  providers: [AgentRagService, KnowledgeRetrievalService, EmbeddingService],
  exports: [AgentRagService, KnowledgeRetrievalService],
})
export class AgentRagModule {}
