import { AuditEvent, isLlmUsage, TokenUsage } from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SpendCapService } from './spend-cap.service';

/**
 * Records one insert-only {@link TokenUsage} row per LLM call, read off a
 * saved {@link AuditEvent}'s payload, and hands it to {@link SpendCapService}
 * for cap evaluation. Called from `AuditService.write` for every event — most
 * carry no `usage` and are a no-op.
 */
@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);
  /** Providers already reported as untracked by this process — saves a doomed insert per call. */
  private readonly untrackedReported = new Set<string>();

  constructor(
    @InjectRepository(TokenUsage)
    private readonly repo: Repository<TokenUsage>,
    private readonly caps: SpendCapService,
  ) {}

  /**
   * Inserts a `token_usage` row when `event.payload.usage` is a valid
   * `LlmUsage`, then starts cap evaluation without waiting for it. A failure
   * to record is logged, never thrown — losing one usage row must not fail
   * the audit write it rides alongside.
   */
  async record(event: AuditEvent): Promise<void> {
    const untracked = event.payload['untrackedProvider'];
    if (typeof untracked === 'string') {
      this.reportUntracked(untracked);
      return;
    }

    const usage = event.payload['usage'];
    if (!isLlmUsage(usage)) return;

    try {
      const result = await this.repo.insert({
        companyId: event.companyId,
        taskId: event.taskId ?? undefined,
        agentId: event.agentId ?? undefined,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
      // The row's own timestamp, so a stint starting now includes it.
      const createdAt: unknown = result.generatedMaps[0]?.['createdAt'];
      void this.caps.onUsage(
        usage.provider,
        createdAt instanceof Date ? createdAt : new Date(),
        usage.inputTokens + usage.outputTokens,
      );
    } catch (err) {
      this.logger.error(
        `Failed to record token usage for company ${event.companyId}: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  }

  /** Warns once per provider (per process) that its usage isn't reported. */
  private reportUntracked(provider: string): void {
    if (this.untrackedReported.has(provider)) return;
    this.untrackedReported.add(provider);
    this.caps
      .onUntracked(provider)
      .catch((err: unknown) =>
        this.logger.error(
          `Failed to report untracked provider ${provider}: ${String(err)}`,
        ),
      );
  }
}
