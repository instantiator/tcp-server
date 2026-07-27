import * as Joi from 'joi';

/**
 * Joi validation schema for tcp-mcp-interactions environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(3012),
  TCP_SERVER_URL: Joi.string().uri().required(),
  INTERNAL_API_KEY: Joi.string().required(),
});
