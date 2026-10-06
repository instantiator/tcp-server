import type { StubResponse } from '../config.ts';

/** A route a format exposes for chat-style completions (there may be more than one alias). */
export interface FormatRoute {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
}

/** What `server.ts` needs out of an inbound request to run the matcher. */
export interface ParsedPrompt {
  promptText: string;
  wantsStream: boolean;
  /** Deterministic prompt-token estimate: ⌈JSON length of the request messages / 4⌉. */
  promptTokens: number;
  /** Whether the request asked for a final usage-only chunk in the stream (OpenAI's `stream_options.include_usage`). */
  includeUsageInStream: boolean;
}

export type ErrorKind = 'auth' | 'no-match' | 'exhausted';

export interface FormatError {
  status: number;
  body: unknown;
}

/** One already wire-encoded chunk of a streamed reply (e.g. an SSE `data: ...\n\n` line). */
export type StreamChunk = string;

/**
 * Translates between `tcp-stub-llm`'s internal {@link StubResponse} shape and
 * one real LLM provider's wire format. Everything format-*independent*
 * (which response to pick, delay simulation, auth gating) lives in
 * `server.ts`/`matcher.ts`; an adapter only knows how to parse a request and
 * serialise a reply for its provider.
 */
export interface ApiFormat {
  readonly name: string;
  /** Chat-completion route(s) this format answers on. */
  routes(): FormatRoute[];
  /** Extracts the prompt text and streaming flag from an already JSON-parsed request body. */
  parsePrompt(body: unknown): ParsedPrompt;
  /** The credential header/value this format's real API expects, given the configured key. */
  authHeaderValue(key: string): { header: string; value: string };
  /** Non-streaming reply body for the chosen response, given its prompt-token estimate. */
  buildResponse(response: StubResponse, promptTokens: number): unknown;
  /**
   * Ordered SSE/NDJSON chunks for the chosen response, streamed in sequence.
   * `includeUsageInStream` mirrors the request's `stream_options.include_usage`.
   */
  buildStreamChunks(
    response: StubResponse,
    promptTokens: number,
    includeUsageInStream: boolean,
  ): StreamChunk[];
  /** Error status + body for one of the stub's own failure cases. */
  buildError(kind: ErrorKind): FormatError;
}
