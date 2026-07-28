import { DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type * as Joi from 'joi';

/**
 * Global config for an MCP service, validating the environment at startup so
 * a misconfigured service fails to boot rather than failing on first use.
 *
 * @param validationSchema - Usually built from {@link baseMcpConfigSchema}.
 *   Omit to load config without validating it.
 */
export function mcpConfigModule(
  validationSchema?: Joi.ObjectSchema,
): Promise<DynamicModule> {
  return ConfigModule.forRoot({
    isGlobal: true,
    // Prevents NestJS's own dotenv loading from independently reading the
    // real .env — see apps/tcp-server/src/app.module.ts for why.
    ignoreEnvFile: true,
    ...(validationSchema && {
      validationSchema,
      validationOptions: { abortEarly: true },
    }),
  });
}
