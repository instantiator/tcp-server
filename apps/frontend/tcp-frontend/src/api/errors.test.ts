import { describe, expect, it } from 'vitest';

import { ApiError, apiError, networkError } from './errors';

// `client.test.ts` already covers the 400–500 status range with messages, the
// ValidationPipe array-message join, the statusText fallback, and
// `networkError` from a real `TypeError`. This file is only the fallback
// edges those cases don't reach, plus the two properties `ApiError` exists
// for in the first place (see the doc comment on the class).

describe('apiError', () => {
  it('falls back to "HTTP <status>" when statusText is empty', () => {
    // HTTP/2 carries no reason phrase at all, so `statusText` is `''` rather
    // than absent — a `??` fallback would let the empty string through.
    const response = new Response(null, { status: 500, statusText: '' });

    const error = apiError(response, null);

    expect(error.message).toBe('HTTP 500');
  });

  it('falls back to statusText when the body is a plain string', () => {
    const response = new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });

    const error = apiError(response, 'something went wrong');

    expect(error.message).toBe('Internal Server Error');
  });

  it('falls back to statusText when the body has no message key', () => {
    const response = new Response(null, {
      status: 404,
      statusText: 'Not Found',
    });

    const error = apiError(response, { statusCode: 404, error: 'Not Found' });

    expect(error.message).toBe('Not Found');
  });

  it('falls back rather than producing an empty message', () => {
    const response = new Response(null, {
      status: 400,
      statusText: 'Bad Request',
    });

    const error = apiError(response, { message: '' });

    expect(error.message).toBe('Bad Request');
  });

  it('falls back when message is an empty array', () => {
    const response = new Response(null, {
      status: 400,
      statusText: 'Bad Request',
    });

    const error = apiError(response, { message: [] });

    expect(error.message).toBe('Bad Request');
  });

  it('joins only the string entries of a mixed message array', () => {
    // ValidationPipe's array is always strings in practice, but nothing
    // upstream guarantees it — a caller decoding an unknown body has to
    // survive one that isn't.
    const response = new Response(null, {
      status: 400,
      statusText: 'Bad Request',
    });

    const error = apiError(response, { message: ['ok', 42, null] });

    expect(error.message).toBe('ok');
  });

  it('preserves a null body exactly', () => {
    const response = new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });

    const error = apiError(response, null);

    expect(error.body).toBeNull();
  });

  it('preserves an undefined body exactly', () => {
    const response = new Response(null, {
      status: 500,
      statusText: 'Internal Server Error',
    });

    const error = apiError(response, undefined);

    expect(error.body).toBeUndefined();
  });
});

describe('networkError', () => {
  it.each([
    ['a string cause', 'a string cause'],
    [42, '42'],
  ])(
    'turns a non-Error cause (%p) into its String() form, with status 0 and no body',
    (cause, expectedMessage) => {
      const error = networkError(cause);

      expect(error.message).toBe(expectedMessage);
      expect(error.status).toBe(0);
      expect(error.body).toBeUndefined();
    },
  );
});

describe('ApiError', () => {
  it('is an instanceof Error, named "ApiError"', () => {
    // TanStack Query types `error` as `Error`; this is the reason the class
    // exists at all, rather than a plain object literal.
    const error = new ApiError(500, 'broke', undefined);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ApiError');
  });
});
