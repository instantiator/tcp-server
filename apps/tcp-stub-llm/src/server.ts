import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  maskConfig,
  resolveConfig,
  validateConfig,
  type ResolvedStubLlmConfig,
  type StubLlmConfig,
} from './config.ts';
import { embed, encodeEmbedding } from './embeddings.ts';
import type { ApiFormat } from './formats/api-format.ts';
import { getFormat } from './formats/index.ts';
import { MatcherState, pickResponse } from './matcher.ts';

interface JsonReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function sendJson(res: ServerResponse, reply: JsonReply): void {
  res.writeHead(reply.status, {
    ...reply.headers,
    'Content-Type': 'application/json',
  });
  res.end(JSON.stringify(reply.body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
}

function randomDelay(min: number, max: number): number {
  if (max <= 0) return 0;
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.random() * (hi - lo);
}

function sleep(ms: number): Promise<void> {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

function hasBearerToken(
  headers: IncomingMessage['headers'],
  header: string,
  expected: string,
): boolean {
  return headers[header.toLowerCase()] === expected;
}

/**
 * The running config plus the per-rule cursor state derived from it. Held in
 * one object so a `PUT /stub/config` reload can atomically swap both.
 */
class StubLlmState {
  private config: StubLlmConfig;
  private resolved: ResolvedStubLlmConfig;
  private matcherState = new MatcherState();
  lastChatRequest: unknown = null;

  constructor(initial: StubLlmConfig) {
    this.config = initial;
    this.resolved = resolveConfig(initial);
  }

  get(): {
    config: StubLlmConfig;
    resolved: ResolvedStubLlmConfig;
    matcher: MatcherState;
  } {
    return {
      config: this.config,
      resolved: this.resolved,
      matcher: this.matcherState,
    };
  }

  replace(next: StubLlmConfig): void {
    this.config = next;
    this.resolved = resolveConfig(next);
    this.matcherState = new MatcherState();
    this.lastChatRequest = null;
  }
}

async function handleChatCompletion(
  format: ApiFormat,
  req: IncomingMessage,
  res: ServerResponse,
  state: StubLlmState,
): Promise<void> {
  const body = await readJsonBody(req);
  state.lastChatRequest = body;
  const { resolved, matcher } = state.get();

  if (resolved.key) {
    const { header, value } = format.authHeaderValue(resolved.key);
    if (!hasBearerToken(req.headers, header, value)) {
      sendJson(res, format.buildError('auth'));
      return;
    }
  }

  const { promptText, wantsStream, promptTokens, includeUsageInStream } =
    format.parsePrompt(body);
  const outcome = pickResponse(promptText, resolved, matcher);
  if (!outcome.ok) {
    sendJson(res, format.buildError(outcome.reason));
    return;
  }
  if (outcome.response.refusal) {
    sendJson(res, format.buildRefusal(outcome.response.refusal));
    return;
  }

  if (wantsStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let first = true;
    for (const chunk of format.buildStreamChunks(
      outcome.response,
      promptTokens,
      includeUsageInStream,
    )) {
      if (!first)
        await sleep(randomDelay(resolved.minDelay, resolved.maxDelay));
      first = false;
      res.write(chunk);
    }
    res.end();
    return;
  }

  let totalDelay = 0;
  for (let i = 0; i < wordCount(outcome.response.text); i++) {
    totalDelay += randomDelay(resolved.minDelay, resolved.maxDelay);
  }
  await sleep(totalDelay);
  sendJson(res, {
    status: 200,
    body: format.buildResponse(outcome.response, promptTokens),
  });
}

async function handleEmbeddings(
  req: IncomingMessage,
  res: ServerResponse,
  state: StubLlmState,
): Promise<void> {
  const body = await readJsonBody(req);
  const { resolved } = state.get();
  if (
    resolved.key &&
    !hasBearerToken(req.headers, 'authorization', `Bearer ${resolved.key}`)
  ) {
    sendJson(res, {
      status: 401,
      body: {
        error: {
          message: 'Incorrect API key provided.',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      },
    });
    return;
  }

  const record =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const inputField = record.input;
  const inputs: unknown[] = Array.isArray(inputField)
    ? inputField
    : inputField === undefined
      ? []
      : [inputField];
  const encodingFormat =
    typeof record.encoding_format === 'string'
      ? record.encoding_format
      : undefined;

  sendJson(res, {
    status: 200,
    body: {
      object: 'list',
      model: 'tcp-stub-llm-embed',
      data: inputs.map((text, index) => ({
        object: 'embedding',
        index,
        embedding: encodeEmbedding(embed(String(text)), encodingFormat),
      })),
      usage: { prompt_tokens: 0, total_tokens: 0 },
    },
  });
}

function handleConfigGet(res: ServerResponse, state: StubLlmState): void {
  sendJson(res, { status: 200, body: maskConfig(state.get().config) });
}

async function handleConfigPut(
  req: IncomingMessage,
  res: ServerResponse,
  state: StubLlmState,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const next = validateConfig(body);
    state.replace(next);
    sendJson(res, { status: 200, body: maskConfig(next) });
  } catch (cause) {
    sendJson(res, {
      status: 400,
      body: { error: cause instanceof Error ? cause.message : String(cause) },
    });
  }
}

/** Builds an unstarted HTTP server; call `.listen(port)` on the result. */
export function createStubLlmServer(initialConfig: StubLlmConfig): Server {
  const state = new StubLlmState(initialConfig);

  return createServer((req, res) => {
    void (async () => {
      const { resolved } = state.get();
      const format = getFormat(resolved.apiFormat);
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';

      try {
        if (method === 'GET' && url.pathname === '/health') {
          sendJson(res, { status: 200, body: { status: 'ok' } });
          return;
        }
        if (
          format
            .routes()
            .some((r) => r.method === method && r.path === url.pathname)
        ) {
          await handleChatCompletion(format, req, res, state);
          return;
        }
        if (method === 'POST' && url.pathname === '/v1/embeddings') {
          await handleEmbeddings(req, res, state);
          return;
        }
        if (method === 'GET' && url.pathname === '/stub/last-request') {
          sendJson(res, { status: 200, body: state.lastChatRequest });
          return;
        }
        if (method === 'GET' && url.pathname === '/stub/config') {
          handleConfigGet(res, state);
          return;
        }
        if (method === 'PUT' && url.pathname === '/stub/config') {
          await handleConfigPut(req, res, state);
          return;
        }
        sendJson(res, { status: 404, body: { error: 'not found' } });
      } catch (cause) {
        sendJson(res, {
          status: 400,
          body: {
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      }
    })();
  });
}
