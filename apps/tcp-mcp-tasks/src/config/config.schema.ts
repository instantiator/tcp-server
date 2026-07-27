import * as Joi from 'joi';

/**
 * Joi validation schema for tcp-mcp-tasks environment variables; startup fails
 * if any required variable is absent or invalid. No storage URL is needed — the
 * output gate that checks storage runs in tcp-server, not here.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(3013),
  TCP_SERVER_URL: Joi.string().uri().required(),
  INTERNAL_API_KEY: Joi.string().required(),
});
