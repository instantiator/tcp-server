import { findProvider } from '@tcp/shared/llm/provider-catalogue';
import type { LlmProviderConfig } from '../types';
import { PROBE_TIMEOUT_MS, probeDimension } from './dimension-prober';
import type { DimensionProbeResult } from './dimension-prober';

/**
 * Result of validating an LLM provider configuration.
 */
export interface ModelValidationResult {
  success: boolean;
  error?: string;
  /** Detected embedding dimension — only populated for embedding models. */
  dimension?: number;
}

/** What {@link describeProbeError} needs to explain a failed probe. */
export interface ProbeErrorInput {
  url: string;
  providerName: string;
  model: string;
  /** The HTTP status, when the server responded but not with 2xx. */
  status?: number;
  /** The response body (or a description of what was wrong with it). */
  body?: string;
  /** The thrown error, when the request itself failed (network, timeout). */
  error?: unknown;
}

/**
 * Turns a failed probe into the message the wizard (and `--test-config`)
 * show: what went wrong, in terms the user can act on. Never echoes the API
 * key — nothing here reads `config.apiKey`.
 */
export function describeProbeError(input: ProbeErrorInput): string {
  if (input.status !== undefined) {
    if (input.status === 401 || input.status === 403) {
      return 'The API key was rejected.';
    }
    if (input.status === 404) {
      return `Model '${input.model}' wasn't found. Check the name, or that it's loaded.`;
    }
    const detail = input.body ? `: ${input.body.slice(0, 300)}` : '';
    return `HTTP ${input.status}${detail}`;
  }

  if (isTimeout(input.error)) {
    return `No reply within ${PROBE_TIMEOUT_MS / 1000}s. A local server may still be loading the model — try again.`;
  }

  const code = causeCode(input.error);
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') {
    return `Nothing is answering at ${input.url}. Is ${input.providerName} running?`;
  }

  return input.error instanceof Error
    ? input.error.message
    : String(input.error);
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

/** The `code` on a fetch failure's `cause` (e.g. `ECONNREFUSED`), if there is one. */
function causeCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('cause' in error)) return undefined;
  const cause = error.cause;
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return undefined;
  }
  return typeof cause.code === 'string' ? cause.code : undefined;
}

/**
 * Tests connectivity to an LLM provider: a chat completion for an inference
 * model, a test embedding for an embedding model (which also reports the
 * vector width).
 */
export async function validateModel(
  config: LlmProviderConfig,
  purpose: 'embedding' | 'chat' = 'chat',
  fetchFn: typeof fetch = fetch,
): Promise<ModelValidationResult> {
  return purpose === 'embedding'
    ? validateEmbeddingModel(config, fetchFn)
    : validateChatModel(config, fetchFn);
}

async function validateEmbeddingModel(
  config: LlmProviderConfig,
  fetchFn: typeof fetch,
): Promise<ModelValidationResult> {
  const probe = await probeDimension(config, fetchFn);
  if (probe.dimension === null) {
    return { success: false, error: probeErrorMessage(config, probe) };
  }
  return { success: true, dimension: probe.dimension };
}

async function validateChatModel(
  config: LlmProviderConfig,
  fetchFn: typeof fetch,
): Promise<ModelValidationResult> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  try {
    const res = await fetchFn(url, {
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
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (!res.ok) {
      return {
        success: false,
        error: describeProbeError({
          url,
          providerName: providerName(config),
          model: config.model,
          status: res.status,
          body: await res.text(),
        }),
      };
    }

    if (!hasChoice((await res.json()) as unknown)) {
      return { success: false, error: 'Response had no completion choices.' };
    }
    return { success: true };
  } catch (error: unknown) {
    return {
      success: false,
      error: describeProbeError({
        url,
        providerName: providerName(config),
        model: config.model,
        error,
      }),
    };
  }
}

function probeErrorMessage(
  config: LlmProviderConfig,
  probe: DimensionProbeResult,
): string {
  return describeProbeError({
    url: `${config.baseUrl.replace(/\/+$/, '')}/embeddings`,
    providerName: providerName(config),
    model: config.model,
    status: probe.status,
    body: probe.body,
    error: probe.error,
  });
}

/** The catalogue's display name for `config.provider`, or the raw id if it isn't listed. */
function providerName(config: LlmProviderConfig): string {
  return findProvider(config.provider)?.name ?? config.provider;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasChoice(body: unknown): boolean {
  return (
    isRecord(body) && Array.isArray(body.choices) && body.choices.length > 0
  );
}
