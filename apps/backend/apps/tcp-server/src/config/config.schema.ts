import * as Joi from 'joi';
import {
  DEFAULT_EXPOSE_PORT_API,
  DEFAULT_MINIO_BUCKET_PREFIX,
  DEFAULT_KNOWLEDGE_POLL_INTERVAL_MS,
  DEFAULT_TCP_MASK_API_KEYS,
  DEFAULT_EMBEDDING_DIMENSION,
} from '@tcp/shared/config/defaults';

/**
 * Joi validation schema for tcp-server environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(DEFAULT_EXPOSE_PORT_API),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET_PREFIX: Joi.string().default(DEFAULT_MINIO_BUCKET_PREFIX),
  /** Interval (ms) between knowledge-reindex reconciliation poll cycles. */
  KNOWLEDGE_POLL_INTERVAL_MS: Joi.number()
    .integer()
    .positive()
    .default(DEFAULT_KNOWLEDGE_POLL_INTERVAL_MS),
  OIDC_ISSUER_URL: Joi.string().uri().required(),
  // Override for container-to-container calls; OIDC_ISSUER_URL is still used for iss validation.
  OIDC_INTERNAL_ISSUER_URL: Joi.string().uri().optional(),
  // Explicit JWKS URI override. If unset, discovered from OIDC_ISSUER_URL/.well-known/openid-configuration.
  OIDC_JWKS_URI: Joi.string().uri().optional(),
  // Audience claim to validate. If unset, audience validation is skipped.
  OIDC_AUDIENCE: Joi.string().optional(),
  OIDC_CLIENT_ID: Joi.string().required(),
  OIDC_CLIENT_SECRET: Joi.string().required(),
  /**
   * Comma-separated OIDC `sub` claims and/or email addresses permitted to use
   * `?all=true` and the system routes. Empty (the default) means no caller is
   * an administrator — the fail-closed choice, because a deployment that
   * forgets to set it should lose an administrative view, not gain one.
   */
  TCP_ADMIN_IDENTIFIERS: Joi.string().allow('').default(''),
  // When true, apiKey values in LlmConfig are replaced with '***' in API responses.
  TCP_MASK_API_KEYS: Joi.boolean().default(DEFAULT_TCP_MASK_API_KEYS),
  // Shared secret used to authenticate internal service-to-service calls (tcp-agent, MCP servers).
  INTERNAL_API_KEY: Joi.string().required(),
  // Environment-level LLM fallback — used when neither a role's llmConfig nor a company's llmConfig is set.
  // Both LLM_PROVIDER and LLM_MODEL must be present to activate the fallback; all other fields are optional.
  // MCP server URLs — each optional; omit to disable that service.
  MCP_STORAGE_URL: Joi.string().uri().empty('').optional(),
  MCP_MEMORY_URL: Joi.string().uri().empty('').optional(),
  MCP_INTERACTIONS_URL: Joi.string().uri().empty('').optional(),
  MCP_TASKS_URL: Joi.string().uri().empty('').optional(),
  /**
   * Comma-separated hostnames a local or custom LLM provider's `baseUrl` may
   * use, besides the hosts of LLM_BASE_URL and EMBEDDING_BASE_URL. Remote
   * providers are held to their catalogue URL regardless. See
   * LlmDestinationPolicy.
   */
  LLM_ALLOWED_HOSTS: Joi.string().allow('').default(''),
  LLM_PROVIDER: Joi.string().empty('').optional(),
  LLM_MODEL: Joi.string().empty('').optional(),
  LLM_BASE_URL: Joi.string().uri().empty('').optional(),
  LLM_API_KEY: Joi.string().empty('').optional(),
  /** Overrides {@link DEFAULT_LLM_CONTEXT_WINDOW} when set. */
  LLM_CONTEXT_WINDOW: Joi.number().integer().positive().empty('').optional(),
  /** Overrides {@link DEFAULT_LLM_TIMEOUT_MS} when set. */
  LLM_TIMEOUT_MS: Joi.number().integer().positive().empty('').optional(),
  // Environment-level embedding fallback — used when a company has no embeddingConfig.
  // Both EMBEDDING_PROVIDER and EMBEDDING_MODEL must be present to activate the fallback.
  EMBEDDING_PROVIDER: Joi.string().empty('').optional(),
  EMBEDDING_MODEL: Joi.string().empty('').optional(),
  EMBEDDING_BASE_URL: Joi.string().uri().empty('').optional(),
  EMBEDDING_API_KEY: Joi.string().empty('').optional(),
  // Vector column width for embeddings. Changing this requires a database migration.
  // Compose passes an unset value as '', which means "use the default".
  EMBEDDING_DIMENSION: Joi.number()
    .integer()
    .min(1)
    .empty('')
    .default(DEFAULT_EMBEDDING_DIMENSION),

  /**
   * Overrides {@link DEFAULT_RAG_THRESHOLD} when set. Per-role and
   * per-company `runConfig.ragThreshold` take precedence. Calibrate to the
   * embedding model in use — cosine scores don't compare across models.
   */
  RAG_THRESHOLD: Joi.number().min(0).max(1).empty('').optional(),
});
