import type { ProviderTemplate } from '@tcp/shared/llm/provider-catalogue';

/** A model's context window, and where the wizard read it from. */
export interface ContextWindowResult {
  tokens: number;
  source: string;
}

/**
 * Looks up a model's context window without asking the user: LM Studio and
 * Ollama expose it through their own local APIs, and models.dev has it for
 * providers listed there. Returns `undefined` on any failure — an
 * unreachable server, an unlisted model, a malformed response — so the
 * caller always has a fallback: asking.
 */
export async function lookupContextWindow(
  template: ProviderTemplate,
  model: string,
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ContextWindowResult | undefined> {
  if (template.id === 'lm-studio') {
    return lookupLmStudio(model, baseUrl, fetchFn);
  }
  if (template.id === 'ollama') {
    return lookupOllama(model, baseUrl, fetchFn);
  }
  if (template.modelsDevId) {
    return lookupModelsDev(template.modelsDevId, model, fetchFn);
  }
  return undefined;
}

/** LM Studio's own `GET /api/v0/models/<id>`, not the OpenAI-compatible API. */
async function lookupLmStudio(
  model: string,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<ContextWindowResult | undefined> {
  const origin = originOf(baseUrl);
  if (!origin) return undefined;

  const body = await getJson(
    `${origin}/api/v0/models/${encodeURIComponent(model)}`,
    fetchFn,
  );
  const tokens =
    numberField(body, 'loaded_context_length') ??
    numberField(body, 'max_context_length');
  return tokens !== undefined ? { tokens, source: 'LM Studio' } : undefined;
}

/** Ollama's `POST /api/show`, whose `model_info` keys are model-family prefixed. */
async function lookupOllama(
  model: string,
  baseUrl: string,
  fetchFn: typeof fetch,
): Promise<ContextWindowResult | undefined> {
  const origin = originOf(baseUrl);
  if (!origin) return undefined;

  const body = await getJson(`${origin}/api/show`, fetchFn, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  const modelInfo = objectField(body, 'model_info');
  if (!modelInfo) return undefined;

  const key = Object.keys(modelInfo).find((k) => k.endsWith('.context_length'));
  const tokens = key ? numberField(modelInfo, key) : undefined;
  return tokens !== undefined ? { tokens, source: 'Ollama' } : undefined;
}

/** `https://models.dev/api.json`'s `[providerId].models[model].limit.context`. */
async function lookupModelsDev(
  modelsDevId: string,
  model: string,
  fetchFn: typeof fetch,
): Promise<ContextWindowResult | undefined> {
  const body = await getJson('https://models.dev/api.json', fetchFn);
  const provider = objectField(body, modelsDevId);
  const models = provider && objectField(provider, 'models');
  const modelEntry = models && objectField(models, model);
  const limit = modelEntry && objectField(modelEntry, 'limit');
  const tokens = limit && numberField(limit, 'context');
  return tokens !== undefined ? { tokens, source: 'models.dev' } : undefined;
}

/** `new URL(baseUrl).origin`, or `undefined` when `baseUrl` doesn't parse. */
function originOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

/**
 * Fetches and parses a JSON body within a 5-second budget, returning
 * `undefined` for a network error, a timeout or a non-2xx response — every
 * lookup here is best-effort, never the only way to get a context window.
 */
async function getJson(
  url: string,
  fetchFn: typeof fetch,
  init?: RequestInit,
): Promise<unknown> {
  try {
    const res = await fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return undefined;
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function objectField(
  value: unknown,
  key: string,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return isRecord(field) ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === 'number' ? field : undefined;
}
