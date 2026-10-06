import {
  classifyRateLimitError,
  parseRetryAfterMs,
} from '@langchain/core/utils/async_caller';

/**
 * What a provider's refusal means for when to try again.
 *
 * `rate` is a short-term limit that clears by itself; `quota` is a used-up
 * allowance (credit, spend limit) that usually needs a person, so it is
 * retried far less often. `retryAt` is the provider's own hint, when it gave
 * one.
 */
export interface RateLimit {
  kind: 'rate' | 'quota';
  retryAt?: Date;
}

/** How often to retry when the provider gives no hint. */
export interface RateLimitCadence {
  /** First wait after a hint-less rate limit; doubles on each repeat. */
  retryMs: number;
  /** Ceiling for the doubling wait. */
  retryMaxMs: number;
  /** Wait after a used-up quota. */
  quotaRetryMs: number;
}

/**
 * Error codes that mean a used-up allowance rather than a passing limit.
 * LangChain recognises only `insufficient_quota`; the rest come from
 * OpenAI's and Anthropic's error docs (see `docs/llm-rate-limits.md`).
 */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'credit_balance_exhausted',
  'enforced_spend_limit_reached',
]);

/**
 * Reads a provider's refusal from the error the LLM call threw, or returns
 * `undefined` when it isn't one.
 *
 * Builds on LangChain's own 429 classification (which already reads
 * `Retry-After`, "try again in N s" message text and quota wording), adding
 * OpenRouter's 402, the quota codes LangChain doesn't know, Azure's
 * `retry-after-ms`, and the reset headers OpenAI and Anthropic send. Reset
 * headers are read by `provider`, never by name alone: OpenAI's and Azure's
 * share a name but not a unit.
 *
 * A 429 with no hint is `rate`, never guessed to be `quota`: Mistral, Bedrock
 * and Gemini often send no header on an ordinary limit, and the doubling
 * backoff reaches long waits by itself if the limit persists.
 *
 * @param now - Injected for tests.
 */
export function classifyRateLimit(
  err: unknown,
  provider: string,
  now = Date.now(),
): RateLimit | undefined {
  const langchain = classifyRateLimitError(err);
  const isQuota402 = statusOf(err) === 402;
  if (!langchain && !isQuota402) return undefined;

  const quota =
    isQuota402 ||
    langchain?.action === 'stop' ||
    QUOTA_CODES.has(codeOf(err) ?? '');
  const retryMs =
    numberHeader(err, 'retry-after-ms') ??
    langchain?.retryAfterMs ??
    parseRetryAfterMs(header(err, 'retry-after'));
  const retryAt =
    retryMs !== undefined
      ? new Date(now + retryMs)
      : hintedRetryAt(err, provider, now);
  return { kind: quota ? 'quota' : 'rate', retryAt };
}

/**
 * When to try again: the provider's hint if it gave one, otherwise the
 * cadence — doubling per consecutive rate limit up to the ceiling, or the
 * longer quota wait.
 *
 * @param attempt - 1 for the first rate limit in a row, 2 for the next…
 */
export function rateLimitRetryAt(
  limit: RateLimit,
  attempt: number,
  cadence: RateLimitCadence,
  now = Date.now(),
): Date {
  if (limit.retryAt) return limit.retryAt;
  if (limit.kind === 'quota') return new Date(now + cadence.quotaRetryMs);
  const backoff = cadence.retryMs * 2 ** Math.max(0, attempt - 1);
  return new Date(now + Math.min(backoff, cadence.retryMaxMs));
}

/** The latest reset time among a provider's own reset headers, if any. */
function hintedRetryAt(
  err: unknown,
  provider: string,
  now: number,
): Date | undefined {
  const parse = RESET_HEADERS[provider];
  if (!parse) return undefined;
  const times = parse.names
    .map((name) => header(err, name))
    .map((value) =>
      value === undefined ? undefined : parse.toTime(value, now),
    )
    .filter((t): t is number => t !== undefined && !Number.isNaN(t));
  return times.length > 0 ? new Date(Math.max(...times)) : undefined;
}

/**
 * Reset headers by catalogue provider id. Only those whose unit the
 * provider documents: OpenRouter's `X-RateLimit-Reset` unit is unstated, so
 * it relies on `Retry-After` like the rest.
 */
const RESET_HEADERS: Record<
  string,
  { names: string[]; toTime: (value: string, now: number) => number }
> = {
  // Go-style durations: "1s", "6m0s", "2m59.56s".
  openai: {
    names: ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'],
    toTime: (value, now) => now + goDurationMs(value),
  },
  // Plain integer seconds — same names as OpenAI's, different unit.
  azure: {
    names: ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'],
    toTime: (value, now) => now + Number(value) * 1000,
  },
  // RFC 3339 timestamps.
  anthropic: {
    names: [
      'anthropic-ratelimit-requests-reset',
      'anthropic-ratelimit-tokens-reset',
      'anthropic-ratelimit-input-tokens-reset',
      'anthropic-ratelimit-output-tokens-reset',
    ],
    toTime: (value) => Date.parse(value),
  },
};

/** Parses a Go duration such as `6m0s` or `1h2m3.5s` to milliseconds. */
export function goDurationMs(value: string): number {
  const match =
    /^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/.exec(
      value.trim(),
    );
  if (!match || match[0] === '') return NaN;
  const [, h, m, s, ms] = match.map((part) => Number(part ?? 0));
  return ((h * 60 + m) * 60 + s) * 1000 + ms;
}

/** The HTTP status the error carries, from the OpenAI SDK or a wrapped response. */
function statusOf(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  if ('status' in err && typeof err.status === 'number') return err.status;
  if (
    'response' in err &&
    typeof err.response === 'object' &&
    err.response !== null &&
    'status' in err.response &&
    typeof err.response.status === 'number'
  ) {
    return err.response.status;
  }
  return undefined;
}

/** The provider's error code, top-level or nested in its error body. */
function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  if ('code' in err && typeof err.code === 'string') return err.code;
  if ('error' in err && typeof err.error === 'object' && err.error !== null) {
    const body = err.error;
    if ('code' in body && typeof body.code === 'string') return body.code;
    if (
      'details' in body &&
      typeof body.details === 'object' &&
      body.details !== null &&
      'error_code' in body.details &&
      typeof body.details.error_code === 'string'
    ) {
      return body.details.error_code;
    }
  }
  return undefined;
}

/** One response header from the error, whether `Headers` or a plain object. */
function header(err: unknown, name: string): string | undefined {
  if (typeof err !== 'object' || err === null || !('headers' in err)) {
    return undefined;
  }
  const headers = err.headers;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (typeof headers === 'object' && headers !== null) {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name && typeof value === 'string') return value;
    }
  }
  return undefined;
}

/** A header holding a plain non-negative number, or `undefined`. */
function numberHeader(err: unknown, name: string): number | undefined {
  const value = header(err, name);
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
