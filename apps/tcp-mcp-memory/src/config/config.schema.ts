import { baseMcpConfigSchema } from '@tcp/shared';
import * as Joi from 'joi';

/** Joi validation schema for tcp-mcp-memory required environment variables. */
export const configSchema = baseMcpConfigSchema(3011).keys({
  DATABASE_URL: Joi.string().uri().required(),
  // Environment-level embedding fallback — used when a company has no embeddingConfig.
  // Both EMBEDDING_PROVIDER and EMBEDDING_MODEL must be present to activate the fallback.
  EMBEDDING_PROVIDER: Joi.string().empty('').optional(),
  EMBEDDING_MODEL: Joi.string().empty('').optional(),
  EMBEDDING_BASE_URL: Joi.string().uri().empty('').optional(),
  EMBEDDING_API_KEY: Joi.string().empty('').optional(),
});
