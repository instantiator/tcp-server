import type { StringKey } from '../strings';

/**
 * Every failed API call, in one shape (ADR-021).
 *
 * A class rather than a plain object because TanStack Query types `error` as
 * `Error`: an object thrown from a query function loses `instanceof` narrowing
 * at every call site, and shows in devtools as `{}`.
 *
 * `message` is tcp-server's own text, for a developer reading a console or a
 * bug report. It is **not** a user-facing string — a view maps {@link status}
 * to its own `t()` key, because the server's wording is neither translated nor
 * written for the person looking at the screen.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The message NestJS put in an error body, if it put one there.
 *
 * Two shapes come back from tcp-server. Most exceptions produce
 * `{ statusCode, message: string, error }`; a `ValidationPipe` rejection
 * produces `message` as an **array**, one entry per failed constraint. A
 * caller that only handles the string sees `[object Object]` on exactly the
 * errors a user is most likely to hit.
 */
const messageIn = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const { message } = body as { message?: unknown };
  if (typeof message === 'string' && message !== '') return message;
  if (Array.isArray(message) && message.length > 0) {
    return message.filter((part) => typeof part === 'string').join('; ');
  }
  return null;
};

/**
 * An {@link ApiError} for a response tcp-server refused, given the body the
 * fetch layer has already parsed out of it.
 *
 * The body is passed in rather than read here: by the time this is called the
 * response stream has been consumed, and reading it again throws a "body
 * already read" that hides the real failure.
 */
export const apiError = (response: Response, body: unknown): ApiError => {
  // `statusText` is a string that is often empty — HTTP/2 does not carry a
  // reason phrase at all — so this is a `||` check, not a `??` one.
  const fallback =
    response.statusText === ''
      ? `HTTP ${String(response.status)}`
      : response.statusText;
  return new ApiError(response.status, messageIn(body) ?? fallback, body);
};

/**
 * An {@link ApiError} for a request that never reached tcp-server at all —
 * offline, DNS failure, a refused connection, a blocked cross-origin call.
 *
 * Status `0` because there is no HTTP status to report, and a view switching
 * on status needs one value that means "this never landed" rather than a
 * plausible-looking 500 it might tell the user to retry.
 */
export const networkError = (cause: unknown): ApiError =>
  new ApiError(
    0,
    cause instanceof Error ? cause.message : String(cause),
    undefined,
  );

/** The task action a refusal came from, since a 409 means something different for each. */
export type RefusalAction =
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'edit'
  | 'closeVisualisation'
  | 'shutdown';

/**
 * The string to show when the server refuses a task action, chosen by status
 * (and by action for a 409, where the wrong state differs per action).
 * Anything unrecognised gets the generic "that didn't work".
 */
export const refusalKey = (err: unknown, action: RefusalAction): StringKey => {
  if (!(err instanceof ApiError)) return 'refusal.failed';
  switch (err.status) {
    case 0:
      return 'refusal.offline';
    case 403:
      return 'refusal.forbidden';
    case 404:
      return 'refusal.notFound';
    case 409:
      return `refusal.${action}.wrongState`;
    case 422:
      return 'refusal.start.noPlanner';
    case 503:
      return 'refusal.shuttingDown';
    default:
      return err.status >= 500 ? 'refusal.server' : 'refusal.failed';
  }
};
