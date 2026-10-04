import { classifyProbeError, isCapabilityRefusal } from './probe-error';

/** Stands in for an OpenAI SDK error class, which is matched by name. */
class APIConnectionError extends Error {}
class APIConnectionTimeoutError extends Error {}

/** A body an internal service might return; it must never reach the caller. */
const BODY = 'root:x:0:0:root:/root:/bin/bash';

const withStatus = (status: number) =>
  Object.assign(new Error(`${status} ${BODY}`), { status });

const timeout = Object.assign(new Error(BODY), { name: 'TimeoutError' });

const config = {
  provider: 'openai',
  model: 'gpt-5-mini',
  baseUrl: 'https://api.openai.com/v1',
};

describe('classifyProbeError', () => {
  it.each([
    ['a wrapped timeout', 'timeout', timeout],
    ['a raw SDK timeout', 'timeout', new APIConnectionTimeoutError(BODY)],
    ['a refused connection', 'unreachable', new APIConnectionError(BODY)],
    ['401', 'auth_rejected', withStatus(401)],
    ['403', 'forbidden', withStatus(403)],
    ['404', 'model_not_found', withStatus(404)],
    ['429', 'rate_limited', withStatus(429)],
    ['503', 'provider_error', withStatus(503)],
    ['418', 'failed', withStatus(418)],
    ['a plain Error', 'failed', new Error(BODY)],
    ['a thrown string', 'failed', BODY],
  ])('classifies %s as %s, without echoing it', (_label, code, err) => {
    const result = classifyProbeError(err, config);

    expect(result.code).toBe(code);
    expect(result.message).not.toContain(BODY);
  });

  it('names the host the caller asked for, and the timeout it allowed', () => {
    const { message } = classifyProbeError(timeout, {
      ...config,
      timeoutMs: 5000,
    });

    expect(message).toContain('api.openai.com');
    expect(message).toContain('5000 ms');
  });

  it("points a rejected key at the provider's keys page", () => {
    expect(classifyProbeError(withStatus(401), config).message).toContain(
      'https://platform.openai.com/api-keys',
    );
  });
});

describe('isCapabilityRefusal', () => {
  it.each([
    ['400', true, withStatus(400)],
    ['422', true, withStatus(422)],
    [
      'a parse failure',
      true,
      Object.assign(new Error('x'), { name: 'OutputParserException' }),
    ],
    ['401', false, withStatus(401)],
    ['a plain Error', false, new Error('x')],
  ])('%s → %s', (_label, expected, err) => {
    expect(isCapabilityRefusal(err)).toBe(expected);
  });
});
