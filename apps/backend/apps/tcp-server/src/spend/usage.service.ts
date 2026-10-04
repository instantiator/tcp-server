import { AuditEvent, isLlmUsage, TokenUsage } from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

/**
 * Records one insert-only {@link TokenUsage} row per LLM call, read off a
 * saved {@link AuditEvent}'s payload. Called from `AuditService.write` for
 * every event — most carry no `usage` and are a no-op.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    @InjectRepository(TokenUsage)
    private readonly repo: Repository<TokenUsage>,
  ) {}

  /**
   * Inserts a `token_usage` row when `event.payload.usage` is a valid
   * `LlmUsage`. A failure to record is logged, never thrown — losing one
   * usage row must not fail the audit write it rides alongside.
   */
  async record(event: AuditEvent): Promise<void> {
    const usage = event.payload['usage'];
    if (!isLlmUsage(usage)) return;

    try {
      await this.repo.insert({
        companyId: event.companyId,
        taskId: event.taskId ?? undefined,
        agentId: event.agentId ?? undefined,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    } catch (err) {
      this.logger.error(
        `Failed to record token usage for company ${event.companyId}: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }
}
