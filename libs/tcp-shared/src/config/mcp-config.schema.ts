import * as Joi from 'joi';

/**
 * The environment every MCP service needs: the port it listens on and the
 * credentials for calling tcp-server's `/internal/*` endpoints.
 *
 * Services with further requirements compose on top, e.g.
 * `baseMcpConfigSchema(3011).keys({ DATABASE_URL: … })`.
 *
 * @param defaultPort - Port used when `PORT` is unset.
 */
export function baseMcpConfigSchema(defaultPort: number): Joi.ObjectSchema {
  return Joi.object({
    PORT: Joi.number().default(defaultPort),
    TCP_SERVER_URL: Joi.string().uri().required(),
    INTERNAL_API_KEY: Joi.string().required(),
  });
}
