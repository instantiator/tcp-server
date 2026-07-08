import type { LlmConfig } from '../models/LlmConfig.model';
import type { WithLlmConfig } from '../models/WithLlmConfig';
import { PrecedenceResolver } from './precedence-resolver';

/**
 * Resolves the {@link LlmConfig} to use for an agent run, in the standard
 * precedence order: role → company → environment-configured fallback.
 *
 * @param role - The role for the current agent run (may be null).
 * @param company - The company for the current agent run (may be null).
 * @param envFallback - Value built from environment variables (e.g. via
 *   `resolveEnvLlmConfig`), or undefined if none is configured.
 */
export class LlmConfigResolver extends PrecedenceResolver<LlmConfig> {
  constructor(
    private readonly role: WithLlmConfig | null | undefined,
    private readonly company: WithLlmConfig | null | undefined,
    private readonly envFallback: LlmConfig | null | undefined,
  ) {
    super();
  }

  protected getSources(): Array<LlmConfig | null | undefined> {
    return [this.role?.llmConfig, this.company?.llmConfig];
  }

  protected getDefault(): LlmConfig | undefined {
    return this.envFallback ?? undefined;
  }
}

/** Convenience wrapper: `new LlmConfigResolver(role, company, envFallback).resolve()`. */
export function resolveLlmConfig(
  role: WithLlmConfig | null | undefined,
  company: WithLlmConfig | null | undefined,
  envFallback: LlmConfig | null | undefined,
): LlmConfig | undefined {
  return new LlmConfigResolver(role, company, envFallback).resolve();
}
