import type { LlmProviderConfig } from '../types';
import { probeDimension } from './dimension-prober';

/**
 * Result of validating an LLM provider configuration.
 */
export interface ModelValidationResult {
  success: boolean;
  error?: string;
  /** Detected embedding dimension — only populated for embedding models. */
  dimension?: number;
}

/**
 * Tests connectivity to an LLM provider and validates the configuration.
 *
 * - For embedding models (those with a `dimension` hint or when `purpose` is
 *   `'embedding'`): sends a test embedding and returns the detected dimension.
 * - For chat/inference models: sends a test completion request.
 */
export async function validateModel(
  config: LlmProviderConfig,
  purpose: 'embedding' | 'chat' = 'chat',
): Promise<ModelValidationResult> {
  if (purpose === 'embedding') {
    return validateEmbeddingModel(config);
  }
  return validateChatModel(config);
}

async function validateEmbeddingModel(
  config: LlmProviderConfig,
): Promise<ModelValidationResult> {
  const probe = await probeDimension(config);
  if (probe.dimension === null) {
    return { success: false, error: probe.error };
  }
  return { success: true, dimension: probe.dimension };
}

async function validateChatModel(
  config: LlmProviderConfig,
): Promise<ModelValidationResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'Say "ok"' }],
        max_tokens: 5,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { success: false, error: `HTTP ${res.status}: ${text}` };
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!data.choices?.length) {
      return { success: false, error: 'Response missing choices' };
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}
