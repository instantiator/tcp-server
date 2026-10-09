import type { LlmConfig } from '../models/LlmConfig.model';
import { findProvider } from './provider-catalogue';
import { hostOf, runFailure, type RunFailure } from './run-failure';

/** How long to wait for a local server's model list. */
export const MODEL_READINESS_TIMEOUT_MS = 10_000;

/** The model ids an OpenAI-style `GET /models` body lists, if it is one. */
function listedModels(body: unknown): string[] | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  return data
    .map((m) => (m as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string');
}

/**
 * Asks a local or custom model server, before a run, whether it is there and
 * lists the model — a short check, so a wrong address fails in seconds, not
 * after the run's long generation timeout.
 *
 * It matters most for a wrong model name: LM Studio answers a request for a
 * model it doesn't have with whichever model is loaded, so the run would
 * quietly use another model. A listed but unloaded model passes: LM Studio
 * lists downloaded models, and loads one on first use.
 *
 * Remote providers are skipped (their lists can omit what they serve, such
 * as Azure deployments). Any answer that doesn't settle it — an error status,
 * a body that isn't a model list — lets the run go ahead, so the real call's
 * own error is what gets reported.
 *
 * @returns The failure to report, or `null` to go ahead.
 */
export async function checkModelReady(
  config: LlmConfig,
  fetchFn: typeof fetch = fetch,
  timeoutMs = MODEL_READINESS_TIMEOUT_MS,
): Promise<RunFailure | null> {
  const kind = findProvider(config.provider)?.kind;
  if (!config.baseUrl || (kind !== 'local' && kind !== 'custom')) return null;
  const host = hostOf(config);
  let res: Response;
  try {
    res = await fetchFn(`${config.baseUrl.replace(/\/$/, '')}/models`, {
      headers: config.apiKey
        ? { Authorization: `Bearer ${config.apiKey}` }
        : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return runFailure('unreachable', { host });
  }
  if (!res.ok) return null;
  const models = listedModels(await res.json().catch(() => null));
  if (!models || models.includes(config.model)) return null;
  return runFailure('model_not_found', { model: config.model, host });
}
