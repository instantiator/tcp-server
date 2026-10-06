import type { LlmConfig } from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  limitsFor,
  type ModelConcurrencyConfig,
  type ModelConcurrencyLimits,
} from './model-concurrency';

/** A run's hold on its pool and endpoint slots. */
export interface ModelSlotLease {
  /**
   * Gives the slots back. Returns the id of the oldest waiting job that can
   * now start, if any, for the caller to promote. Safe to call twice.
   */
  release(): string | undefined;
}

/** The lease for a run nothing limits (its provider couldn't be resolved). */
export const UNLIMITED_LEASE: ModelSlotLease = { release: () => undefined };

/**
 * Counts agent runs against the `MODEL_CONCURRENCY` limits: one pool per
 * provider kind (local, remote) and, where configured, one per endpoint. A
 * run starts only when both its pool and its endpoint have room, and takes
 * both slots or neither.
 *
 * Jobs refused a slot are remembered in arrival order, so a release can name
 * the next one that fits rather than leaving it to its delay timer.
 *
 * ponytail: in-memory, so it assumes one tcp-agent process (already assumed
 * by the worker). Scaling out needs the counts in Redis.
 */
@Injectable()
export class ModelSlotService {
  private readonly config: ModelConcurrencyConfig;
  private readonly held = new Map<string, number>();
  /** Refused jobs, oldest first, with the limits they are waiting on. */
  private readonly waiting = new Map<string, ModelConcurrencyLimits>();

  constructor(config: ConfigService) {
    this.config = config.get<ModelConcurrencyConfig>('MODEL_CONCURRENCY') ?? {};
  }

  /**
   * The limits a run against `llm` counts against, or `undefined` for a
   * provider the catalogue doesn't know — that run is let through, so the
   * agent loop fails it with its usual message instead of it waiting forever.
   */
  limitsFor(llm: LlmConfig): ModelConcurrencyLimits | undefined {
    try {
      return limitsFor(llm, this.config);
    } catch {
      return undefined;
    }
  }

  /**
   * Takes a pool slot and an endpoint slot for `jobId`, or neither.
   *
   * @returns The lease, or `null` when either is full — the job is then
   *   remembered as waiting until a release names it or it acquires later.
   */
  tryAcquire(
    limits: ModelConcurrencyLimits,
    jobId: string,
  ): ModelSlotLease | null {
    if (!this.fits(limits)) {
      if (!this.waiting.has(jobId)) this.waiting.set(jobId, limits);
      return null;
    }
    this.waiting.delete(jobId);
    const keys = slotKeys(limits);
    for (const key of keys) this.held.set(key, (this.held.get(key) ?? 0) + 1);

    let released = false;
    return {
      release: () => {
        if (released) return undefined;
        released = true;
        for (const key of keys) {
          const left = (this.held.get(key) ?? 1) - 1;
          if (left > 0) this.held.set(key, left);
          else this.held.delete(key);
        }
        return this.nextWaiter(limits.pool);
      },
    };
  }

  /** Whether the run's pool and endpoint both have room. */
  private fits(limits: ModelConcurrencyLimits): boolean {
    const [pool, endpoint] = slotKeys(limits);
    return (
      this.hasRoom(pool, limits.poolLimit) &&
      this.hasRoom(endpoint, limits.endpointLimit)
    );
  }

  private hasRoom(key: string, limit: number | null): boolean {
    return limit === null || (this.held.get(key) ?? 0) < limit;
  }

  /**
   * The oldest waiting job in `pool` that fits now. Only that pool can have
   * gained room: endpoints belong to one pool, so a release frees nothing
   * elsewhere.
   */
  private nextWaiter(pool: string): string | undefined {
    for (const [jobId, limits] of this.waiting) {
      if (limits.pool === pool && this.fits(limits)) {
        this.waiting.delete(jobId);
        return jobId;
      }
    }
    return undefined;
  }
}

/** The pool and endpoint counters a run occupies, in that order. */
function slotKeys(limits: ModelConcurrencyLimits): [string, string] {
  return [`pool:${limits.pool}`, `endpoint:${limits.endpointKey}`];
}
