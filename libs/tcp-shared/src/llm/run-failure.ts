import type { LlmConfig } from '../models/LlmConfig.model';
import { classifyProbeError, isCapabilityRefusal } from './provider-error';

/**
 * Why an agent run failed: the extendable set behind every `failureReason` a
 * user sees. Adding a reason is one code here, one entry in
 * {@link RUN_FAILURE_MESSAGES} (the type makes it required) and one test.
 */
export type RunFailureCode =
  // The provider: the user must fix the setup, then start the task again.
  | 'unreachable'
  | 'llm_timeout'
  | 'auth_rejected'
  | 'forbidden'
  | 'model_not_found'
  | 'tools_unsupported'
  | 'provider_error'
  // The run itself.
  | 'no_llm_config'
  | 'run_timed_out'
  | 'iteration_limit'
  | 'context_too_long'
  | 'required_tools_missing'
  | 'no_output'
  | 'repeating_call'
  | 'service_unavailable'
  | 'stopped'
  | 'interrupted'
  | 'unexpected';

/** What a message may mention. Each message reads only what it needs. */
export interface RunFailureContext {
  /** The provider's host, or its name for a catalogue provider. */
  host?: string;
  model?: string;
  /** The run's wall-clock limit, in seconds. */
  seconds?: number;
  iterations?: number;
  /** Tool names, as the agent saw them. */
  tools?: string[];
  /** The repeated call's result, first line only. */
  result?: string;
  /** The supporting service that failed. */
  service?: string;
  /** Free text from the cause, when nothing more specific is known. */
  detail?: string;
}

/** A classified failure: `message` says what went wrong and what to do. */
export interface RunFailure {
  code: RunFailureCode;
  message: string;
}

/**
 * The message for each failure, in plain words. Each says what went wrong
 * and, where the user can act, what to do. The provider messages come from
 * {@link classifyProbeError}, so a model check and a run say the same thing.
 */
export const RUN_FAILURE_MESSAGES: Record<
  RunFailureCode,
  (ctx: RunFailureContext) => string
> = {
  unreachable: (c) =>
    `Couldn't connect to ${c.host ?? 'the model provider'}. Check it is running and the base URL is right, then start the task again.`,
  llm_timeout: (c) =>
    `${c.host ?? 'The model provider'} didn't answer in time. A local model may still be loading: try again, or raise the timeout.`,
  auth_rejected: () =>
    'The model provider rejected the API key. Check the key, then start the task again.',
  forbidden: () =>
    "The API key isn't allowed to use this model. Check the key's permissions, then start the task again.",
  model_not_found: (c) =>
    `The model${c.model ? ` '${c.model}'` : ''} wasn't found${c.host ? ` at ${c.host}` : ''}. Check its name, and that a local server has it downloaded, then start the task again.`,
  tools_unsupported: (c) =>
    `The model${c.model ? ` '${c.model}'` : ''} refused the request, probably because it can't call tools. Choose a model that supports tool calls for this role.`,
  provider_error: () =>
    'The model provider had a fault on its side. Try again later.',
  no_llm_config: () =>
    'No model is set for this role or its company. Set one, then start the task again.',
  run_timed_out: (c) =>
    `The agent ran out of time${c.seconds ? ` (${c.seconds} seconds)` : ''}. Simplify the request, or raise the run's time limit.`,
  iteration_limit: (c) =>
    `The agent took more than ${c.iterations ?? 'the allowed number of'} steps without finishing. Simplify the request, or try a more capable model.`,
  context_too_long: () =>
    "The conversation grew too long for the model's context window, even after trimming. Use a model with a larger context window, or split the request.",
  required_tools_missing: (c) =>
    `The agent stopped without calling ${c.tools?.join(', ') ?? 'a required tool'}, even after reminders. Try a more capable model for this role.`,
  no_output: () =>
    'The model returned nothing, even after a retry. Try again, or try another model.',
  repeating_call: (c) =>
    `The agent kept making the same ${c.tools?.[0] ?? 'tool'} call and getting the same answer${c.result ? `: "${c.result}"` : ''}. Try a more capable model for this role, or simplify the request.`,
  service_unavailable: (c) =>
    `${c.service ?? 'A supporting service'} didn't respond. Check it is running, then start the task again.`,
  stopped: (c) =>
    `The run was stopped before it finished${c.detail ? ` (${c.detail})` : ''}. Start the task again if it is still needed.`,
  interrupted: () =>
    "This step stopped unexpectedly and couldn't be carried on. Start the task again.",
  unexpected: (c) =>
    `Something unexpected went wrong${c.detail ? `: ${c.detail}` : ''}. Details are in the server log.`,
};

/** Builds the failure for `code`. */
export function runFailure(
  code: RunFailureCode,
  ctx: RunFailureContext = {},
): RunFailure {
  return { code, message: RUN_FAILURE_MESSAGES[code](ctx) };
}

/** What an abort's reason means; anything else is a stop by someone. */
const ABORT_CODES: Record<string, RunFailureCode> = {
  timeout: 'run_timed_out',
  max_iterations: 'iteration_limit',
  context_window_exceeded: 'context_too_long',
  repeating_call: 'repeating_call',
};

/** Classifies an aborted run by its abort reason. */
export function abortFailure(
  reason: unknown,
  ctx: RunFailureContext = {},
): RunFailure {
  const detail = typeof reason === 'string' ? reason : undefined;
  const code = detail !== undefined ? ABORT_CODES[detail] : undefined;
  return code ? runFailure(code, ctx) : runFailure('stopped', { detail });
}

/**
 * Names the supporting service an error came from, by marks its client
 * libraries leave on it, or `undefined` when it isn't one of them.
 */
function failedService(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { name?: unknown; $metadata?: unknown; message?: unknown };
  // The AWS SDK, behind storage, tags every error with `$metadata`.
  if (e.$metadata !== undefined) return 'Storage (MinIO)';
  if (e.name === 'McpError') return 'An MCP service';
  if (e.name === 'MaxRetriesPerRequestError') return 'Redis';
  if (e.name === 'QueryFailedError' || e.name === 'ConnectionIsNotSetError') {
    return 'The database';
  }
  return undefined;
}

/**
 * Classifies an error that ended a run. Provider errors are recognised by
 * {@link classifyProbeError}; the provider's own text is never echoed, as it
 * may hold whatever answered at the address. An unrecognised error keeps its
 * own message as detail, since it comes from this system, not the provider.
 */
export function classifyRunError(
  err: unknown,
  config: LlmConfig,
  ctx: RunFailureContext = {},
): RunFailure {
  const service = failedService(err);
  if (service) return runFailure('service_unavailable', { service });

  const host = ctx.host ?? hostOf(config);
  const model = config.model;
  if (isCapabilityRefusal(err)) {
    return runFailure('tools_unsupported', { model });
  }
  switch (classifyProbeError(err, config).code) {
    case 'unreachable':
      return runFailure('unreachable', { host });
    case 'timeout':
      return runFailure('llm_timeout', { host });
    case 'auth_rejected':
      return runFailure('auth_rejected');
    case 'forbidden':
      return runFailure('forbidden');
    case 'model_not_found':
      return runFailure('model_not_found', { model, host });
    case 'provider_error':
      return runFailure('provider_error');
    default: {
      const detail = err instanceof Error ? err.message : String(err);
      return runFailure('unexpected', { detail: detail.trim() || undefined });
    }
  }
}

/** The host to name in a message: the base URL's, or the provider's id. */
export function hostOf(config: LlmConfig): string {
  if (!config.baseUrl) return config.provider;
  try {
    return new URL(config.baseUrl).host;
  } catch {
    return config.baseUrl;
  }
}
