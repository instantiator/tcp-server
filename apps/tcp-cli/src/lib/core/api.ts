/**
 * Thin fetch wrapper for tcp-server API calls.
 *
 * All methods write progress/errors to stderr and return parsed JSON.
 * HTTP errors are surfaced as thrown `Error` instances so callers can decide
 * whether to crash or continue.
 */

import { printWarning } from './warn';

/** Header the server uses to report soft data-quality warnings (see `validation-warnings.ts` in tcp-server). */
const WARNINGS_HEADER = 'X-Tcp-Warnings';

export interface ApiOptions {
  /** Base URL of the tcp-server (e.g. `http://localhost:3000`). */
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

  reportWarnings(res);

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/**
 * Prints any `X-Tcp-Warnings` reported by the server (see {@link WARNINGS_HEADER}).
 *
 * Each entry is percent-encoded server-side (see `setWarningsHeader` in
 * tcp-server's `validation-warnings.ts`) so warning content carrying
 * non-Latin1 characters — e.g. an arbitrary third-party error message —
 * never gets lost to HTTP header validation. Decode each entry back before
 * printing; a single undecodable entry (malformed percent-escape) falls
 * back to its raw, still-encoded form rather than dropping the whole batch.
 */
export function reportWarnings(res: Response): void {
  const raw = res.headers?.get(WARNINGS_HEADER);
  if (!raw) return;
  try {
    const warnings = JSON.parse(raw) as string[];
    warnings.forEach((w) => {
      try {
        printWarning(decodeURIComponent(w));
      } catch {
        printWarning(w);
      }
    });
  } catch {
    // ignore malformed header — not worth failing the command over
  }
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

  reportWarnings(res);

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
 *
 * A document-validation failure (422) carries `errors[].llmHint` —
 * remediation text such as a minimal front-matter template — which is
 * appended to the thrown error's message so it reaches the CLI user, not
 * just `message` (see `DocumentValidationException` in tcp-server).
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
      const err = (await res.json()) as {
        message?: string;
        errors?: { llmHint?: string }[];
      };
      detail = err.message ? `: ${err.message}` : '';
      const hints = (err.errors ?? [])
        .map((e) => e.llmHint)
        .filter((hint): hint is string => Boolean(hint));
      if (hints.length > 0) detail += `\n${hints.join('\n')}`;
    } catch {
      /* ignore */
    }
    throw new Error(`POST ${path} failed with HTTP ${res.status}${detail}`);
  }

  reportWarnings(res);

  return res.json() as Promise<T>;
}
