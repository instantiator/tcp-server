import { baseMcpConfigSchema } from '@tcp/shared';

/**
 * Joi validation schema for tcp-mcp-interactions environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = baseMcpConfigSchema(3012);
