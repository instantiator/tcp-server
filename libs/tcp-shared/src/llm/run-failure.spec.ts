import type { LlmConfig } from '../models/LlmConfig.model';
import {
  abortFailure,
  classifyRunError,
  RUN_FAILURE_MESSAGES,
  type RunFailureCode,
} from './run-failure';

/** Stands in for the OpenAI SDK's connection error, matched by class name. */
class APIConnectionError extends Error {}

/** An error carrying an HTTP status, as SDK errors do. */
const httpError = (status: number): Error =>
  Object.assign(new Error(`HTTP ${status}: provider says something`), {
    status,
  });

const config: LlmConfig = {
  provider: 'lm-studio',
  model: 'qwen3',
  baseUrl: 'http://gpu-box:1234/v1',
};

describe('RUN_FAILURE_MESSAGES', () => {
  // Every reason has words a user can act on, with or without context.
  it.each(Object.keys(RUN_FAILURE_MESSAGES) as RunFailureCode[])(
    '%s has a message',
    (code) => {
      expect(RUN_FAILURE_MESSAGES[code]({}).length).toBeGreaterThan(20);
      expect(
        RUN_FAILURE_MESSAGES[code]({
          host: 'h',
          model: 'm',
          seconds: 1,
          iterations: 2,
          tools: ['t'],
          result: 'r',
          service: 's',
          detail: 'd',
        }),
      ).not.toContain('undefined');
    },
  );
});

describe('classifyRunError', () => {
  it.each<[string, unknown, RunFailureCode]>([
    [
      'a refused connection',
      new APIConnectionError('Connection error.'),
      'unreachable',
    ],
    [
      'an LLM call timeout',
      Object.assign(new Error('t'), { name: 'TimeoutError' }),
      'llm_timeout',
    ],
    ['a rejected key', httpError(401), 'auth_rejected'],
    ['a forbidden model', httpError(403), 'forbidden'],
    ['an unknown model', httpError(404), 'model_not_found'],
    ['a refused tool schema', httpError(400), 'tools_unsupported'],
    ['a provider fault', httpError(503), 'provider_error'],
    [
      'a storage error',
      Object.assign(new Error('NoSuchBucket'), { $metadata: {} }),
      'service_unavailable',
    ],
    [
      'an MCP error',
      Object.assign(new Error('x'), { name: 'McpError' }),
      'service_unavailable',
    ],
    [
      'an MCP server down at tool load',
      Object.assign(new Error('x'), {
        name: 'McpServerUnavailableError',
        serverName: 'tasks',
      }),
      'service_unavailable',
    ],
    [
      'a Redis error',
      Object.assign(new Error('x'), { name: 'MaxRetriesPerRequestError' }),
      'service_unavailable',
    ],
    [
      'a database error',
      Object.assign(new Error('x'), { name: 'QueryFailedError' }),
      'service_unavailable',
    ],
    ['anything else', new Error('checkpointer setup broke'), 'unexpected'],
  ])('classifies %s', (_label, err, code) => {
    expect(classifyRunError(err, config).code).toBe(code);
  });

  it('names the MCP server a run needed but could not reach', () => {
    const err = Object.assign(new Error('x'), {
      name: 'McpServerUnavailableError',
      serverName: 'tasks',
    });
    expect(classifyRunError(err, config).message).toBe(
      "The tasks service (MCP) didn't respond. Check it is running, then start the task again.",
    );
  });

  it("never echoes a provider's own text", () => {
    expect(classifyRunError(httpError(404), config).message).not.toContain(
      'provider says',
    );
  });

  it('names the host and model for a missing model', () => {
    expect(classifyRunError(httpError(404), config).message).toBe(
      "The model 'qwen3' wasn't found at gpu-box:1234. Check its name, and that a local server has it downloaded, then start the task again.",
    );
  });

  it("keeps this system's own error text as detail", () => {
    expect(
      classifyRunError(new Error('checkpointer setup broke'), config).message,
    ).toContain('checkpointer setup broke');
  });
});

describe('abortFailure', () => {
  it.each<[string, RunFailureCode]>([
    ['timeout', 'run_timed_out'],
    ['max_iterations', 'iteration_limit'],
    ['context_window_exceeded', 'context_too_long'],
    ['repeating_call', 'repeating_call'],
    ['forced drain', 'stopped'],
  ])('reads the abort reason %s', (reason, code) => {
    expect(abortFailure(reason).code).toBe(code);
  });

  it('quotes the repeated call', () => {
    expect(
      abortFailure('repeating_call', {
        tools: ['create_plan'],
        result: '2 values were not valid:',
      }).message,
    ).toContain(
      'same create_plan call and getting the same answer: "2 values were not valid:"',
    );
  });
});
