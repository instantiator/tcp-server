import Joi from 'joi';

/** Joi validation schema for lcp-mcp-memory required environment variables. */
export const configSchema = Joi.object({
  DATABASE_URL: Joi.string().uri().required(),
  LCP_SERVER_URL: Joi.string().uri().required(),
  INTERNAL_API_KEY: Joi.string().required(),
});
