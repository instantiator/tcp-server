import * as Joi from 'joi';

/**
 * Joi validation schema for lcp-agent environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(3001),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MCP_STORAGE_URL: Joi.string().uri().optional(),
  MCP_MEMORY_URL: Joi.string().uri().optional(),
  MCP_INTERACTIONS_URL: Joi.string().uri().optional(),
  LCP_SERVER_URL: Joi.string().uri().required(),
  INTERNAL_API_KEY: Joi.string().required(),
  /** Overrides {@link DEFAULT_AGENT_ITERATIONS} when set. Per-role and per-company runConfig take precedence. */
  AGENT_ITERATIONS: Joi.number().integer().positive().optional(),
  /** Overrides {@link DEFAULT_AGENT_LOOP_TIMEOUT_MS} when set. Per-role and per-company runConfig take precedence. */
  AGENT_LOOP_TIMEOUT_MS: Joi.number().integer().positive().optional(),
});
