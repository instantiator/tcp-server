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

/**
 * Downloads a file from the given path and returns it as a {@link Buffer}.
 * Throws on non-OK responses.
 */
export async function apiDownload(
  opts: ApiOptions,
  path: string,
): Promise<{ data: Buffer; contentType: string; filename: string }> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}${path}`;
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(url, { method: 'GET', headers, signal: opts.signal });

  if (!res.ok) {
    let detail = '';
    try {
      const err = (await res.json()) as { message?: string };
      detail = err.message ? `: ${err.message}` : '';
    } catch {
      // ignore
    }
    throw new Error(`GET ${path} failed with HTTP ${res.status}${detail}`);
  }

  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match?.[1] ?? 'download';
  const contentType =
    res.headers.get('content-type') ?? 'application/octet-stream';
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType, filename };
}

/**
 * Uploads a single file to the given path using `multipart/form-data`.
 * The file is sent in a field named `file`.
 */
export async function apiUpload<T>(
  opts: ApiOptions,
  path: string,
  filename: string,
  data: Buffer,
  contentType = 'application/octet-stream',
): Promise<T> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}${path}`;
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(data)], { type: contentType }),
    filename,
  );

  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(url, { method: 'POST', headers, body: form });

  if (!res.ok) {
    let detail = '';
    try {
      const err = (await res.json()) as { message?: string };
      detail = err.message ? `: ${err.message}` : '';
    } catch {
      /* ignore */
    }
    throw new Error(`POST ${path} failed with HTTP ${res.status}${detail}`);
  }

  return res.json() as Promise<T>;
}
