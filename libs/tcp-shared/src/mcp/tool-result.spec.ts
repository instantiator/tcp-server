import { Logger } from '@nestjs/common';
import { AxiosError, AxiosHeaders } from 'axios';
import {
  err,
  extractServerErrorMessage,
  ok,
  relay4xxOrError,
} from './tool-result';

/** Builds an AxiosError carrying `data` at `status`, as axios would in the wild. */
function axiosError(status: number, data: unknown): AxiosError {
  const error = new AxiosError('Request failed', 'ERR_BAD_REQUEST');
  error.response = {
    status,
    statusText: '',
    data,
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  };
  return error;
}

function textOf(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

describe('ok / err', () => {
  it('wraps text as a single text content block', () => {
    expect(ok('hello')).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('prefixes err text so the model reads it as a failure', () => {
    expect(textOf(err('boom'))).toBe('Error: boom');
  });
});

describe('relay4xxOrError', () => {
  // A 4xx carries a corrective message the model can act on, so it comes back
  // as a normal result; anything else is opaque to the model and falls back.
  it.each([400, 404, 422, 499])(
    'relays the message from a %s as a non-error result',
    (status) => {
      const result = relay4xxOrError(
        axiosError(status, { message: 'fix your call' }),
        'fallback',
      );
      expect(textOf(result)).toBe('fix your call');
    },
  );

  it.each([399, 500, 503])('falls back for a %s', (status) => {
    const result = relay4xxOrError(
      axiosError(status, { message: 'fix your call' }),
      'fallback',
    );
    expect(textOf(result)).toBe('Error: fallback');
  });

  it('joins an array of validation messages', () => {
    const result = relay4xxOrError(
      axiosError(400, { message: ['too short', 'wrong type'] }),
      'fallback',
    );
    expect(textOf(result)).toBe('too short; wrong type');
  });

  it('prefers llmHint over the generic message', () => {
    const result = relay4xxOrError(
      axiosError(422, {
        message: 'Validation failed',
        errors: [{ llmHint: 'Pass a bare filename.' }, { llmHint: 'Retry.' }],
      }),
      'fallback',
    );
    expect(textOf(result)).toBe('Pass a bare filename. Retry.');
  });

  it('falls back when a 4xx carries no message at all', () => {
    expect(textOf(relay4xxOrError(axiosError(404, {}), 'fallback'))).toBe(
      'Error: fallback',
    );
  });

  it('falls back for a non-axios error', () => {
    expect(textOf(relay4xxOrError(new Error('socket'), 'fallback'))).toBe(
      'Error: fallback',
    );
  });

  it('logs against the tool name only when it cannot relay', () => {
    const logger = { error: jest.fn() } as unknown as Logger;
    relay4xxOrError(axiosError(400, { message: 'fix it' }), 'fallback', {
      tool: 'read_file',
      logger,
    });
    expect(logger.error).not.toHaveBeenCalled();

    relay4xxOrError(axiosError(500, {}), 'fallback', {
      tool: 'read_file',
      logger,
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('read_file failed'),
    );
  });
});

describe('extractServerErrorMessage', () => {
  it('prefers llmHint prose', () => {
    expect(
      extractServerErrorMessage(
        axiosError(422, {
          message: 'Validation failed',
          errors: [{ llmHint: 'Use a relative path.' }],
        }),
      ),
    ).toBe('Use a relative path.');
  });

  it('falls back to the response message', () => {
    expect(
      extractServerErrorMessage(axiosError(404, { message: 'Not found' })),
    ).toBe('Not found');
  });

  it("falls back to the axios error's own message when the body is empty", () => {
    expect(extractServerErrorMessage(axiosError(500, {}))).toBe(
      'Request failed',
    );
  });

  it('handles non-axios errors and non-Error throwables', () => {
    expect(extractServerErrorMessage(new Error('socket hang up'))).toBe(
      'socket hang up',
    );
    expect(extractServerErrorMessage('just a string')).toBe('just a string');
  });
});
