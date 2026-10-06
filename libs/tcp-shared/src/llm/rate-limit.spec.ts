import {
  classifyRateLimit,
  goDurationMs,
  rateLimitRetryAt,
  type RateLimitCadence,
} from './rate-limit';

const NOW = Date.parse('2026-10-06T12:00:00Z');

/** An error shaped like the OpenAI SDK's `APIError`, as LangChain rethrows it. */
function apiError(
  status: number,
  headers: Record<string, string> = {},
  body: { code?: string; type?: string; details?: { error_code: string } } = {},
  message = `${status} status code`,
): Error {
  return Object.assign(new Error(message), {
    status,
    headers: new Headers(headers),
    error: body,
    code: body.code,
  });
}

const CADENCE: RateLimitCadence = {
  retryMs: 60_000,
  retryMaxMs: 30 * 60_000,
  quotaRetryMs: 60 * 60_000,
};

describe('classifyRateLimit', () => {
  it('ignores errors that are not a provider refusal', () => {
    expect(
      classifyRateLimit(new Error('socket hang up'), 'openai', NOW),
    ).toBeUndefined();
    expect(classifyRateLimit(apiError(500), 'openai', NOW)).toBeUndefined();
    expect(classifyRateLimit(apiError(401), 'openai', NOW)).toBeUndefined();
  });

  describe('OpenAI', () => {
    it('reads Retry-After seconds', () => {
      const rl = classifyRateLimit(
        apiError(429, { 'retry-after': '20' }, { code: 'rate_limit_exceeded' }),
        'openai',
        NOW,
      );
      expect(rl).toEqual({ kind: 'rate', retryAt: new Date(NOW + 20_000) });
    });

    it('falls back to the later Go-duration reset header', () => {
      const rl = classifyRateLimit(
        apiError(429, {
          'x-ratelimit-reset-requests': '1s',
          'x-ratelimit-reset-tokens': '6m0s',
        }),
        'openai',
        NOW,
      );
      expect(rl).toEqual({ kind: 'rate', retryAt: new Date(NOW + 360_000) });
    });

    it.each([
      'insufficient_quota',
      'organization_spend_limit_exceeded',
      'credit_balance_exhausted',
    ])('treats %s as a used-up quota', (code) => {
      expect(
        classifyRateLimit(apiError(429, {}, { code }), 'openai', NOW)?.kind,
      ).toBe('quota');
    });
  });

  describe('Anthropic', () => {
    it('reads Retry-After for an ordinary rate limit', () => {
      const rl = classifyRateLimit(
        apiError(429, { 'retry-after': '5' }, { type: 'rate_limit_error' }),
        'anthropic',
        NOW,
      );
      expect(rl).toEqual({ kind: 'rate', retryAt: new Date(NOW + 5_000) });
    });

    it('falls back to the latest RFC 3339 reset header', () => {
      const rl = classifyRateLimit(
        apiError(429, {
          'anthropic-ratelimit-requests-reset': '2026-10-06T12:00:30Z',
          'anthropic-ratelimit-tokens-reset': '2026-10-06T12:01:00Z',
        }),
        'anthropic',
        NOW,
      );
      expect(rl?.retryAt).toEqual(new Date('2026-10-06T12:01:00Z'));
    });

    it('treats an enforced spend limit as a used-up quota', () => {
      const rl = classifyRateLimit(
        apiError(
          429,
          {},
          {
            type: 'rate_limit_error',
            details: { error_code: 'enforced_spend_limit_reached' },
          },
        ),
        'anthropic',
        NOW,
      );
      expect(rl?.kind).toBe('quota');
    });
  });

  describe('Azure', () => {
    it('prefers retry-after-ms over Retry-After', () => {
      const rl = classifyRateLimit(
        apiError(429, { 'retry-after-ms': '1500', 'retry-after': '2' }),
        'azure',
        NOW,
      );
      expect(rl?.retryAt).toEqual(new Date(NOW + 1_500));
    });

    it('reads its reset headers as plain seconds, not Go durations', () => {
      const rl = classifyRateLimit(
        apiError(429, { 'x-ratelimit-reset-tokens': '300' }),
        'azure',
        NOW,
      );
      expect(rl?.retryAt).toEqual(new Date(NOW + 300_000));
    });
  });

  describe('OpenRouter', () => {
    it('treats 402 as a used-up quota', () => {
      expect(classifyRateLimit(apiError(402), 'openrouter', NOW)).toEqual({
        kind: 'quota',
        retryAt: undefined,
      });
    });

    it('honours Retry-After on an in-flight-budget 402', () => {
      expect(
        classifyRateLimit(
          apiError(402, { 'retry-after': '30' }),
          'openrouter',
          NOW,
        ),
      ).toEqual({ kind: 'quota', retryAt: new Date(NOW + 30_000) });
    });

    it('reads Retry-After on a 429', () => {
      const rl = classifyRateLimit(
        apiError(429, { 'retry-after': '10' }),
        'openrouter',
        NOW,
      );
      expect(rl?.retryAt).toEqual(new Date(NOW + 10_000));
    });
  });

  it('reads a "try again in" hint from the message (Groq, Mistral style)', () => {
    const rl = classifyRateLimit(
      apiError(429, {}, {}, 'Rate limit reached. Please try again in 7.5s.'),
      'mistral',
      NOW,
    );
    expect(rl).toEqual({ kind: 'rate', retryAt: new Date(NOW + 7_500) });
  });

  it('treats a 429 with no hint as a rate limit, not a quota', () => {
    expect(classifyRateLimit(apiError(429), 'mistral', NOW)).toEqual({
      kind: 'rate',
      retryAt: undefined,
    });
  });

  it('never reads reset headers for a provider that does not document them', () => {
    const rl = classifyRateLimit(
      apiError(429, { 'x-ratelimit-reset-tokens': '6m0s' }),
      'mistral',
      NOW,
    );
    expect(rl?.retryAt).toBeUndefined();
  });
});

describe('rateLimitRetryAt', () => {
  it("uses the provider's hint when there is one", () => {
    const hint = new Date(NOW + 5_000);
    expect(
      rateLimitRetryAt({ kind: 'rate', retryAt: hint }, 4, CADENCE, NOW),
    ).toBe(hint);
  });

  it('doubles the wait for each rate limit in a row', () => {
    const at = (attempt: number) =>
      rateLimitRetryAt({ kind: 'rate' }, attempt, CADENCE, NOW).getTime() - NOW;
    expect([at(1), at(2), at(3)]).toEqual([60_000, 120_000, 240_000]);
  });

  it('stops doubling at the ceiling', () => {
    expect(
      rateLimitRetryAt({ kind: 'rate' }, 20, CADENCE, NOW).getTime() - NOW,
    ).toBe(30 * 60_000);
  });

  it('waits the quota cadence for a used-up quota, however few attempts', () => {
    expect(
      rateLimitRetryAt({ kind: 'quota' }, 1, CADENCE, NOW).getTime() - NOW,
    ).toBe(60 * 60_000);
  });
});

describe('goDurationMs', () => {
  it.each([
    ['1s', 1_000],
    ['6m0s', 360_000],
    ['2m59.56s', 179_560],
    ['1h2m3s', 3_723_000],
    ['500ms', 500],
  ])('parses %s', (value, ms) => {
    expect(goDurationMs(value)).toBeCloseTo(ms);
  });

  it.each(['', 'soon', '10'])('rejects %p', (value) => {
    expect(goDurationMs(value)).toBeNaN();
  });
});
