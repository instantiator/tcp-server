import { EmbeddingService } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { AgentRagService } from './agent-rag.service';

/**
 * Provides {@link AgentRagService} for tcp-agent's knowledge-base retrieval.
 * Does not include indexing — that is handled by tcp-server.
 */
@Module({
  providers: [AgentRagService, EmbeddingService],
  exports: [AgentRagService],
})
export class AgentRagModule {}
