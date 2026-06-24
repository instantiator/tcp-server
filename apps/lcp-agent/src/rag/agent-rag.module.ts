import { Module } from '@nestjs/common';
import { AgentRagService } from './agent-rag.service';

/**
 * Provides {@link AgentRagService} for lcp-agent's knowledge-base retrieval.
 * Does not include indexing — that is handled by lcp-server.
 */
@Module({
  providers: [AgentRagService],
  exports: [AgentRagService],
})
export class AgentRagModule {}
