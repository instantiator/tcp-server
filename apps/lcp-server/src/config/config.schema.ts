import * as Joi from 'joi';

export const configSchema = Joi.object({
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET_PREFIX: Joi.string().default('lcp'),
  OIDC_ISSUER_URL: Joi.string().uri().required(),
  OIDC_CLIENT_ID: Joi.string().required(),
  OIDC_CLIENT_SECRET: Joi.string().required(),
});
