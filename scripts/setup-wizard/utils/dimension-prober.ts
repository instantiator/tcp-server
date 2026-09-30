import type { LlmProviderConfig } from '../types';

/**
 * How long a probe waits. Generous because a local server (LM Studio, Ollama)
 * loads the model on the first request, which took 28s for a 4B model here.
 */
export const PROBE_TIMEOUT_MS = 60_000;

/**
 * Result of probing an embedding endpoint for its vector width. On failure
 * this carries the raw diagnostic (status/body, or the thrown error) rather
 * than a formatted message — {@link describeProbeError} in `model-validator`
 * turns it into the one the wizard shows.
 */
export interface DimensionProbeResult {
  /** The detected width, or `null` if the probe failed. */
  dimension: number | null;
  /** The HTTP status, when the server responded but not with 2xx. */
  status?: number;
  /** The response body, or a description of what was wrong with it. */
  body?: string;
  /** The thrown error, when the request itself failed (network, timeout). */
  error?: unknown;
}

/**
 * Sends a test embedding request to `<baseUrl>/embeddings` — the same
 * OpenAI-compatible path the backend calls — and returns the vector width
 * from the response. Never appends `/v1`: the base URL already includes it,
 * exactly as the backend treats it.
 */
export async function probeDimension(
  config: LlmProviderConfig,
  fetchFn: typeof fetch = fetch,
): Promise<DimensionProbeResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;

  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, input: 'test' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!res.ok) {
      return { dimension: null, status: res.status, body: await res.text() };
    }

    const embedding = firstEmbedding((await res.json()) as unknown);
    if (!embedding) {
      return { dimension: null, body: 'Response had no embedding array.' };
    }
    return { dimension: embedding.length };
  } catch (error: unknown) {
    return { dimension: null, error };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === 'number')
  );
}

/** The first embedding vector in an OpenAI-style `{ data: [{ embedding }] }` body. */
function firstEmbedding(body: unknown): number[] | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  if (!Array.isArray(data)) return undefined;
  const first: unknown = data[0];
  if (!isRecord(first)) return undefined;
  return isNumberArray(first.embedding) ? first.embedding : undefined;
}
