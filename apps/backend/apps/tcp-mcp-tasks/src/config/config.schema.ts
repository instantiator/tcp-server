import { baseMcpConfigSchema } from '@tcp/shared';

/**
 * Joi validation schema for tcp-mcp-tasks environment variables; startup fails
 * if any required variable is absent or invalid. No storage URL is needed — the
 * output gate that checks storage runs in tcp-server, not here.
 */
export const configSchema = baseMcpConfigSchema(3013);
