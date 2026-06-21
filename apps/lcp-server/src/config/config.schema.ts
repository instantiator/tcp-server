import * as Joi from 'joi';

/**
 * Joi validation schema for lcp-server environment variables.
 * The application will refuse to start if any required variable is absent or invalid.
 */
export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET_PREFIX: Joi.string().default('lcp'),
  OIDC_ISSUER_URL: Joi.string().uri().required(),
  // Override for container-to-container calls; OIDC_ISSUER_URL is still used for iss validation.
  OIDC_INTERNAL_ISSUER_URL: Joi.string().uri().optional(),
  // Explicit JWKS URI override. If unset, discovered from OIDC_ISSUER_URL/.well-known/openid-configuration.
  OIDC_JWKS_URI: Joi.string().uri().optional(),
  // Audience claim to validate. If unset, audience validation is skipped.
  OIDC_AUDIENCE: Joi.string().optional(),
  OIDC_CLIENT_ID: Joi.string().required(),
  OIDC_CLIENT_SECRET: Joi.string().required(),
  // When true, apiKey values in LlmConfig are replaced with '***' in API responses.
  LCP_MASK_API_KEYS: Joi.boolean().default(true),
});
