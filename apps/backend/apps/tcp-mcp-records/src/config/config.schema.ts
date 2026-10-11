import { baseMcpConfigSchema } from '@tcp/shared';
import * as Joi from 'joi';

/** Joi validation schema for tcp-mcp-records environment variables. */
export const configSchema = baseMcpConfigSchema(3015).keys({
  DATABASE_URL: Joi.string().uri().required(),
  // Optional separate database for records; empty means use DATABASE_URL.
  RECORDS_DATABASE_URL: Joi.string().uri().empty('').optional(),
});
