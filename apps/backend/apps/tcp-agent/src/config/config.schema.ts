import * as Joi from 'joi';
import { DEFAULT_EMBEDDING_DIMENSION } from '@tcp/shared/config/defaults';
import { modelConcurrencySchema } from '../worker/model-concurrency';

/**
 * Joi validation schema for tcp-agent environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(3001),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  // True only where a supervisor (Docker's restart policy) starts tcp-agent
  // again after it exits. Without it, a restart command resumes the worker.
  TCP_RESTART_SUPPORTED: Joi.boolean().default(false),
  // No MINIO_* here: tcp-agent never constructs an S3 client. Every storage
  // action it takes goes through tcp-server's /internal/storage/* endpoints.
  MCP_STORAGE_URL: Joi.string().uri().optional(),
  MCP_MEMORY_URL: Joi.string().uri().optional(),
  MCP_INTERACTIONS_URL: Joi.string().uri().optional(),
  MCP_TASKS_URL: Joi.string().uri().optional(),
  TCP_SERVER_URL: Joi.string().uri().required(),
  INTERNAL_API_KEY: Joi.string().required(),
  /** Overrides {@link DEFAULT_AGENT_ITERATIONS} when set. Per-role and per-company runConfig take precedence. */
  AGENT_ITERATIONS: Joi.number().integer().positive().optional(),
  /** Overrides {@link DEFAULT_AGENT_LOOP_TIMEOUT_MS} when set. Per-role and per-company runConfig take precedence. */
  AGENT_LOOP_TIMEOUT_MS: Joi.number().integer().positive().optional(),
  /** Overrides {@link DEFAULT_REQUIRED_TOOL_RETRIES} when set — reminder rounds before a run missing its required tool calls is failed. */
  AGENT_REQUIRED_TOOL_RETRIES: Joi.number().integer().min(0).optional(),
  /** Whether a rate-limited agent resumes by itself (default true); off means only an explicit resume lifts the pause. */
  RATE_LIMIT_AUTO_RESUME: Joi.boolean().empty('').default(true),
  // Asks a local model server for its model list before each run.
  LLM_READINESS_CHECK: Joi.boolean().empty('').default(true),
  /** Overrides {@link DEFAULT_RATE_LIMIT_RETRY_MS} — first wait after a hint-less rate limit. */
  RATE_LIMIT_RETRY_MS: Joi.number().integer().positive().empty('').optional(),
  /** Overrides {@link DEFAULT_RATE_LIMIT_RETRY_MAX_MS} — ceiling for the doubling wait. */
  RATE_LIMIT_RETRY_MAX_MS: Joi.number()
    .integer()
    .positive()
    .empty('')
    .optional(),
  /** Overrides {@link DEFAULT_RATE_LIMIT_QUOTA_RETRY_MS} — wait after a used-up quota. */
  RATE_LIMIT_QUOTA_RETRY_MS: Joi.number()
    .integer()
    .positive()
    .empty('')
    .optional(),
  /** Pool and endpoint run limits — see .env.example for the shape. */
  MODEL_CONCURRENCY: modelConcurrencySchema,
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
