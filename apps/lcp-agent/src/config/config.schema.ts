import * as Joi from 'joi';
import { DEFAULT_EMBEDDING_DIMENSION } from '@lcp/shared/config/defaults';

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
  MCP_TASKS_URL: Joi.string().uri().optional(),
  LCP_SERVER_URL: Joi.string().uri().required(),
  INTERNAL_API_KEY: Joi.string().required(),
  /** Overrides {@link DEFAULT_AGENT_ITERATIONS} when set. Per-role and per-company runConfig take precedence. */
  AGENT_ITERATIONS: Joi.number().integer().positive().optional(),
  /** Overrides {@link DEFAULT_AGENT_LOOP_TIMEOUT_MS} when set. Per-role and per-company runConfig take precedence. */
  AGENT_LOOP_TIMEOUT_MS: Joi.number().integer().positive().optional(),
  /** Overrides {@link DEFAULT_REQUIRED_TOOL_RETRIES} when set — reminder rounds before a run missing its required tool calls is failed. */
  AGENT_REQUIRED_TOOL_RETRIES: Joi.number().integer().min(0).optional(),
  /** Overrides {@link DEFAULT_AGENT_WORKER_CONCURRENCY} — parallel agent jobs. Set to 1 when sharing one local model. */
  AGENT_WORKER_CONCURRENCY: Joi.number().integer().positive().optional(),
  // Environment-level LLM fallback — used when neither a role's llmConfig nor a company's llmConfig is set.
  // Both LLM_PROVIDER and LLM_MODEL must be present to activate the fallback; all other fields are optional.
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
  EMBEDDING_DIMENSION: Joi.number()
    .integer()
    .min(1)
    .default(DEFAULT_EMBEDDING_DIMENSION),

  /**
   * Overrides {@link DEFAULT_RAG_THRESHOLD} when set. Per-role and
   * per-company `runConfig.ragThreshold` take precedence. Calibrate to the
   * embedding model in use — cosine scores don't compare across models.
   */
  RAG_THRESHOLD: Joi.number().min(0).max(1).empty('').optional(),
});
