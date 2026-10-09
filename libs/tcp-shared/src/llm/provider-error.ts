import { DEFAULT_LLM_TIMEOUT_MS } from '../config/defaults';
import type { LlmConfig } from '../models/LlmConfig.model';
import { PROVIDER_CATALOGUE, findProvider } from './provider-catalogue';

/** What went wrong with a model check, for a client to act on. */
export const PROBE_ERROR_CODES = [
  'unsupported_provider',
  'destination_refused',
  'unreachable',
  'timeout',
  'auth_rejected',
  'forbidden',
  'model_not_found',
  'rate_limited',
  'provider_error',
  'failed',
] as const;

export type ProbeErrorCode = (typeof PROBE_ERROR_CODES)[number];

/** A classified probe failure. `message` says how to fix a genuine mistake. */
export interface ProbeError {
  code: ProbeErrorCode;
  message: string;
}

/** The host the caller asked for, as they wrote it; never a resolved address. */
function hostOf(config: LlmConfig): string {
  if (!config.baseUrl)
    return findProvider(config.provider)?.name ?? 'the provider';
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return config.baseUrl;
  }
}

/** The HTTP status an SDK error carries, if any. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * A provider's 400 or 422 to a probe means the model refused the tool
 * definition or the output schema, and a parse failure means it answered but
 * not in the asked-for shape. Either is a capability "no", not a broken setup.
 */
export function isCapabilityRefusal(err: unknown): boolean {
  const status = statusOf(err);
  return (
    status === 400 ||
    status === 422 ||
    (err instanceof Error && err.name === 'OutputParserException')
  );
}

export const unsupportedProvider = (provider: string): ProbeError => ({
  code: 'unsupported_provider',
  message: `Unknown provider '${provider}'. Use one of: ${PROVIDER_CATALOGUE.map((p) => p.id).join(', ')}.`,
});

/**
 * Turns an error from a probe into fixed text that tells the caller what to
 * check. The provider's own message and response body are never included:
 * echoing them would let a caller read whatever answered at the address.
 *
 * Classified by `status`, `name` and constructor name, which survive
 * `@langchain/openai`'s wrapping of OpenAI SDK errors (a timeout becomes a
 * plain `Error` named `TimeoutError`).
 */
export function classifyProbeError(
  err: unknown,
  config: LlmConfig,
): ProbeError {
  const host = hostOf(config);
  const status = statusOf(err);
  const name = err instanceof Error ? err.name : undefined;
  const ctor = (err as object | null)?.constructor?.name;

  if (name === 'TimeoutError' || ctor === 'APIConnectionTimeoutError') {
    const ms = config.timeoutMs || DEFAULT_LLM_TIMEOUT_MS;
    return {
      code: 'timeout',
      message: `${host} didn't answer within ${ms} ms. A local model may still be loading, so try again, or raise timeoutMs.`,
    };
  }
  if (ctor === 'APIConnectionError') {
    return {
      code: 'unreachable',
      message: `Couldn't connect to ${host}. Check the server is running and the base URL is right, including /v1. From inside Docker, the host machine is host.docker.internal, not localhost.`,
    };
  }
  if (status === 401) {
    const keysPage = findProvider(config.provider)?.keysPageUrl;
    return {
      code: 'auth_rejected',
      message: `The provider rejected the API key. Check it is set and belongs to this provider${keysPage ? ` (keys: ${keysPage})` : ''}.`,
    };
  }
  if (status === 403) {
    return {
      code: 'forbidden',
      message:
        "The API key isn't allowed to use this model or API. Check the key's permissions, project or region.",
    };
  }
  if (status === 404) {
    return {
      code: 'model_not_found',
      message: `Model '${config.model}' wasn't found. Check the name (on Azure it is the deployment name), that a local server has it loaded, and that the base URL ends in /v1.`,
    };
  }
  if (status === 429) {
    return {
      code: 'rate_limited',
      message:
        "Rate-limited or out of quota. Check the account's billing or credits, then retry.",
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      code: 'provider_error',
      message: `The provider returned HTTP ${status}, a fault on its side. Retry later.`,
    };
  }
  return {
    code: 'failed',
    message: `The check failed${status ? ` (HTTP ${status})` : ''}. Details are in the server log.`,
  };
}
