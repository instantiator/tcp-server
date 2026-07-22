import {
  AuditEvent,
  CompanyUser,
  Conversation,
  ConversationMessage,
  EpisodicMemory,
  KnowledgeChunk,
  KnowledgeIndexState,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  PendingConsultation,
  makeTypeOrmConfig,
} from '@lcp/shared';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ApiModule } from './api/api.module';
import { AuditModule } from './audit/audit.module';
import { AuthTokenController } from './auth/auth-token.controller';
import { AuthTokenService } from './auth/auth-token.service';
import { AuthModule } from './auth/auth.module';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { MIGRATIONS } from './migrations-list';
import { MaskSecretsInterceptor } from './utils/mask-secrets.interceptor';

/**
 * Root module for lcp-server. Wires global config validation, TypeORM,
 * the REST API, health checks, and OIDC authentication.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Without this, NestJS's own dotenv loading independently reads the
      // real .env alongside whatever the process's own environment already
      // has — meaning a real dev secret sitting in .env silently fills in
      // any test-tier variable that its own env file (e.g. .env.testing)
      // deliberately leaves unset. Every deployment path (docker-compose,
      // and the test harnesses' own .env.testing loading in
      // test/support/testcontainers-env.ts) already fully populates
      // process.env before this module ever runs, so this is never a loss.
      ignoreEnvFile: true,
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    makeTypeOrmConfig(
      [
        LcpCompany,
        LcpRole,
        LcpAgent,
        LcpTask,
        LcpAssignment,
        AuditEvent,
        KnowledgeChunk,
        KnowledgeIndexState,
        EpisodicMemory,
        CompanyUser,
        Conversation,
        ConversationMessage,
        PendingConsultation,
      ],
      MIGRATIONS,
    ),
    ApiModule,
    AuditModule,
    HealthModule,
    AuthModule,
  ],
  controllers: [AuthTokenController],
  providers: [
    AuthTokenService,
    { provide: APP_INTERCEPTOR, useClass: MaskSecretsInterceptor },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: false,
      }),
    },
  ],
})
export class AppModule {}
