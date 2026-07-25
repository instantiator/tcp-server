import type { LlmProviderConfig } from '../types';

/**
 * Result of probing an embedding model for its vector dimension.
 */
export interface DimensionProbeResult {
  /** The detected vector dimension, or null if the probe failed. */
  dimension: number | null;
  /** Human-readable error message if the probe failed. */
  error?: string;
}

/**
 * Sends a test embedding request to the configured endpoint and returns the
 * vector dimension from the response. Uses the OpenAI-compatible
 * `POST /v1/embeddings` API.
 */
export async function probeDimension(
  config: LlmProviderConfig,
): Promise<DimensionProbeResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/v1/embeddings`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: 'test',
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      return { dimension: null, error: `HTTP ${res.status}: ${text}` };
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding || !Array.isArray(embedding)) {
      return { dimension: null, error: 'Response missing embedding array' };
    }

    return { dimension: embedding.length };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { dimension: null, error: message };
  }
}
