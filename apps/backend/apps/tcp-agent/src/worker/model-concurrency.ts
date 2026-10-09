import * as Joi from 'joi';
import {
  DEFAULT_LOCAL_MODEL_CONCURRENCY,
  DEFAULT_REMOTE_MODEL_CONCURRENCY,
  findProvider,
  type LlmConfig,
} from '@tcp/shared';

/**
 * Validated MODEL_CONCURRENCY: two pool totals (by provider kind) plus
 * optional per-endpoint overrides. A missing `local`/`remote` means "use the
 * built-in default"; an explicit `null` means unlimited. A missing endpoint
 * key means that endpoint has no limit of its own.
 */
export interface ModelConcurrencyConfig {
  local?: number | null;
  remote?: number | null;
  endpoints?: Record<string, number | null>;
}

/** The two pools every agent run counts against, by provider kind. */
export type ModelPool = 'local' | 'remote';

/** Where a run's two gates (pool and, if set, endpoint) land. */
export interface ModelConcurrencyLimits {
  pool: ModelPool;
  poolLimit: number | null;
  endpointKey: string;
  endpointLimit: number | null;
}

/** A pool or endpoint limit: a positive integer, or `null` for unlimited. */
const concurrencyLimitSchema = Joi.alternatives(
  Joi.number().integer().positive(),
  Joi.valid(null),
);

const modelConcurrencyObjectSchema = Joi.object<ModelConcurrencyConfig>({
  local: concurrencyLimitSchema.optional(),
  remote: concurrencyLimitSchema.optional(),
  endpoints: Joi.object()
    .pattern(Joi.string(), concurrencyLimitSchema)
    .optional(),
});

/**
 * Validates the raw MODEL_CONCURRENCY env string: parses it as JSON, then
 * checks it against the pool/endpoint shape. Unset or empty (compose passes
 * an unset variable as '') defaults to {} (built-in pool defaults, no
 * endpoint overrides) without running the parser. `convert: false` rejects a
 * stringly-typed limit (e.g. `"2"`) rather than silently coercing it — JSON
 * already gives numbers their own type, so a string here is a mistake, not a
 * style choice. Boot fails on bad JSON or an invalid shape.
 */
export const modelConcurrencySchema: Joi.Schema = Joi.string()
  .empty('')
  .custom((value: string, helpers) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return helpers.message({
        custom: 'MODEL_CONCURRENCY is not valid JSON',
      });
    }
    const result = modelConcurrencyObjectSchema.validate(parsed, {
      convert: false,
    });
    if (result.error) {
      return helpers.message({
        custom: `MODEL_CONCURRENCY ${result.error.message}`,
      });
    }
    return result.value;
  })
  .default({});

/**
 * Lowercases and strips any trailing slash so the same server reached two
 * ways (trailing slash, mixed case) still shares one slot count.
 */
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.toLowerCase().replace(/\/+$/, '');
}

/**
 * The key an endpoint's `MODEL_CONCURRENCY.endpoints` override is keyed by.
 *
 * Remote providers use their catalogue provider id: rate limits and spend are
 * per account, not per base URL. Local and custom providers use the
 * normalised base URL instead: one server is one GPU, whatever model it
 * serves, and a provider id would conflate two different local servers (or
 * fail to tell a custom server from another).
 *
 * @throws if the provider isn't in the catalogue (as {@link buildChatModel} does)
 */
export function endpointKey(llm: LlmConfig): string {
  const template = findProvider(llm.provider);
  if (!template) {
    throw new Error(`Unsupported LLM provider: ${llm.provider}`);
  }
  if (template.kind === 'remote') {
    return template.id;
  }
  return normaliseBaseUrl(llm.baseUrl || template.baseUrl);
}

/**
 * Resolves which pool a run counts against and the limits that apply: the
 * pool total (built-in default when unset, `null` when cleared) and, if
 * `MODEL_CONCURRENCY.endpoints` sets one, that endpoint's own limit. A custom
 * provider counts as local — it's still someone's single server, not a
 * metered account.
 */
export function limitsFor(
  llm: LlmConfig,
  config: ModelConcurrencyConfig,
): ModelConcurrencyLimits {
  const template = findProvider(llm.provider);
  if (!template) {
    throw new Error(`Unsupported LLM provider: ${llm.provider}`);
  }
  const pool: ModelPool = template.kind === 'remote' ? 'remote' : 'local';
  const configured = pool === 'local' ? config.local : config.remote;
  const poolLimit =
    configured === undefined
      ? pool === 'local'
        ? DEFAULT_LOCAL_MODEL_CONCURRENCY
        : DEFAULT_REMOTE_MODEL_CONCURRENCY
      : configured;
  const key = endpointKey(llm);
  const endpointLimit = config.endpoints?.[key] ?? null;
  return { pool, poolLimit, endpointKey: key, endpointLimit };
}
