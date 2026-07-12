import * as Joi from 'joi';

/**
 * Joi validation schema for lcp-server environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET_PREFIX: Joi.string().default('lcp'),
  /** Interval (ms) between knowledge-reindex reconciliation poll cycles. */
  KNOWLEDGE_POLL_INTERVAL_MS: Joi.number().integer().positive().default(60000),
  OIDC_ISSUER_URL: Joi.string().uri().required(),
  // Override for container-to-container calls; OIDC_ISSUER_URL is still used for iss validation.
  OIDC_INTERNAL_ISSUER_URL: Joi.string().uri().optional(),
  // Explicit JWKS URI override. If unset, discovered from OIDC_ISSUER_URL/.well-known/openid-configuration.
  OIDC_JWKS_URI: Joi.string().uri().optional(),
  // Audience claim to validate. If unset, audience validation is skipped.
  OIDC_AUDIENCE: Joi.string().optional(),
  OIDC_CLIENT_ID: Joi.string().required(),
  OIDC_CLIENT_SECRET: Joi.string().required(),
  // When true, apiKey values in LlmConfig are replaced with '***' in API responses.
  LCP_MASK_API_KEYS: Joi.boolean().default(true),
  // Shared secret used to authenticate internal service-to-service calls (lcp-agent, MCP servers).
  INTERNAL_API_KEY: Joi.string().required(),
  // Environment-level LLM fallback — used when neither a role's llmConfig nor a company's llmConfig is set.
  // Both LLM_PROVIDER and LLM_MODEL must be present to activate the fallback; all other fields are optional.
  // MCP server URLs — each optional; omit to disable that service.
  MCP_STORAGE_URL: Joi.string().uri().empty('').optional(),
  MCP_MEMORY_URL: Joi.string().uri().empty('').optional(),
  MCP_INTERACTIONS_URL: Joi.string().uri().empty('').optional(),
  MCP_TASKS_URL: Joi.string().uri().empty('').optional(),
  LLM_PROVIDER: Joi.string().empty('').optional(),
  LLM_MODEL: Joi.string().empty('').optional(),
  LLM_BASE_URL: Joi.string().uri().empty('').optional(),
  LLM_API_KEY: Joi.string().empty('').optional(),
  /** Overrides {@link DEFAULT_LLM_CONTEXT_WINDOW} when set. */
  LLM_CONTEXT_WINDOW: Joi.number().integer().positive().empty('').optional(),
  /** Overrides {@link DEFAULT_LLM_TIMEOUT_MS} when set. */
  LLM_TIMEOUT_MS: Joi.number().integer().positive().empty('').optional(),
});
