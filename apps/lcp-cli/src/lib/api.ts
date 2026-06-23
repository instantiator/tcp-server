/**
 * Thin fetch wrapper for lcp-server API calls.
 *
 * All methods write progress/errors to stderr and return parsed JSON.
 * HTTP errors are surfaced as thrown `Error` instances so callers can decide
 * whether to crash or continue.
 */

export interface ApiOptions {
  /** Base URL of the lcp-server (e.g. `http://localhost:3000`). */
  baseUrl: string;
  /** Bearer token included on every request (optional for token-fetching calls). */
  token?: string;
  /**
   * Optional {@link AbortSignal} forwarded to the underlying `fetch` call.
   * Abort the associated {@link AbortController} to cancel the in-flight request.
   */
  signal?: AbortSignal;
}

/** Performs a fetch to the given path and returns the parsed JSON response. */
export async function apiRequest<T>(
  opts: ApiOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });

  if (!res.ok) {
    let detail = '';
    try {
      const err = (await res.json()) as { message?: string };
      detail = err.message ? `: ${err.message}` : '';
    } catch {
      // ignore parse errors — use status text
    }
    throw new Error(
      `${method} ${path} failed with HTTP ${res.status}${detail}`,
    );
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
