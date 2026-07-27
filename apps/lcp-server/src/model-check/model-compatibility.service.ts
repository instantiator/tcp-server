import { LlmConfig } from '@tcp/shared';
import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { buildChatModel } from './llm-factory';

/** Compatibility report for a single model. */
export interface ModelCompatibilityResult {
  provider: string;
  model: string;
  /** Whether the model accepted a tool definition and returned a tool call. */
  supportsTools: boolean;
  /** Whether the model accepted a structured-output schema and returned conforming JSON. */
  supportsStructuredOutput: boolean;
  /** `true` iff both capabilities are confirmed. */
  compatible: boolean;
  /** Set when the live check could not be completed (network error, bad config, etc.). */
  error?: string;
}

/** Minimal tool definition used for the capability probe. */
const PROBE_TOOL = {
  name: 'echo',
  description: 'Return the input unchanged.',
  schema: z.object({ value: z.string() }),
};

/** Minimal structured-output schema used for the capability probe. */
const PROBE_SCHEMA = z.object({ ok: z.boolean() });

/**
 * Probes one or more LLM configurations to determine whether they support
 * tool calling and structured output — the two capabilities required by the
 * lcp-agent loop.
 *
 * Each check makes a live network call to the configured provider.
 */
@Injectable()
export class ModelCompatibilityService {
  private readonly logger = new Logger(ModelCompatibilityService.name);

  /** Runs compatibility probes for each config in the list. */
  async check(configs: LlmConfig[]): Promise<ModelCompatibilityResult[]> {
    return Promise.all(configs.map((c) => this.checkOne(c)));
  }

  private async checkOne(config: LlmConfig): Promise<ModelCompatibilityResult> {
    let supportsTools = false;
    let supportsStructuredOutput = false;
    let error: string | undefined;

    try {
      const model = buildChatModel(config);
      [supportsTools, supportsStructuredOutput] = await Promise.all([
        this.probeTools(model),
        this.probeStructuredOutput(model),
      ]);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Compatibility check failed for ${config.provider}/${config.model}: ${error}`,
      );
    }

    return {
      provider: config.provider,
      model: config.model,
      supportsTools,
      supportsStructuredOutput,
      compatible: supportsTools && supportsStructuredOutput,
      ...(error && { error }),
    };
  }

  private async probeTools(
    model: ReturnType<typeof buildChatModel>,
  ): Promise<boolean> {
    try {
      if (!model.bindTools) return false;
      const bound = model.bindTools([PROBE_TOOL]);
      const response = await bound.invoke([
        { role: 'user', content: 'Call the echo tool with value "ping".' },
      ]);
      // A tool call in the response confirms support
      return (
        Array.isArray(response.tool_calls) && response.tool_calls.length > 0
      );
    } catch {
      return false;
    }
  }

  private async probeStructuredOutput(
    model: ReturnType<typeof buildChatModel>,
  ): Promise<boolean> {
    try {
      const structured = model.withStructuredOutput(PROBE_SCHEMA);
      const result = await structured.invoke([
        { role: 'user', content: 'Reply with {"ok": true}.' },
      ]);
      return typeof result === 'object' && result !== null && 'ok' in result;
    } catch {
      return false;
    }
  }
}
