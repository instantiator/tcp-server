import {
  AuditEvent,
  CompanyUser,
  Conversation,
  ConversationMessage,
  EpisodicMemory,
  KnowledgeChunk,
  LcpAgent,
  LcpCompany,
  LcpRole,
  PendingConsultation,
} from '@lcp/shared';
import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiModule } from './api/api.module';
import { AuditModule } from './audit/audit.module';
import { AuthTokenController } from './auth/auth-token.controller';
import { AuthTokenService } from './auth/auth-token.service';
import { AuthModule } from './auth/auth.module';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { InitialSchema1750000000000 } from './migrations/1750000000000-InitialSchema';
import { AddRoleAgentAudit1750000000001 } from './migrations/1750000000001-AddRoleAgentAudit';
import { CompanyLlmDefault1750000000002 } from './migrations/1750000000002-CompanyLlmDefault';
import { AddCompanyDescription1782144931792 } from './migrations/1782144931792-AddCompanyDescription';
import { AddRolePromptCompanyContext1782246360783 } from './migrations/1782246360783-AddRolePromptCompanyContext';
import { AddCompanyEmbeddingConfig1782246974102 } from './migrations/1782246974102-AddCompanyEmbeddingConfig';
import { AddKnowledgeChunk1782246974122 } from './migrations/1782246974122-AddKnowledgeChunk';
import { AddEpisodicMemory1782247100000 } from './migrations/1782247100000-AddEpisodicMemory';
import { AddCompanyUser1782247200000 } from './migrations/1782247200000-AddCompanyUser';
import { AddConversation1782247300000 } from './migrations/1782247300000-AddConversation';
import { AddAgentOutputAndConsultation1782247400000 } from './migrations/1782247400000-AddAgentOutputAndConsultation';
import { AddAgentStorageChanges1782247500000 } from './migrations/1782247500000-AddAgentStorageChanges';
import { MaskSecretsInterceptor } from './utils/mask-secrets.interceptor';

/**
 * Root module for lcp-server. Wires global config validation, TypeORM,
 * the REST API, health checks, and OIDC authentication.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('DATABASE_URL') ?? '';
        const entities = [
          LcpCompany,
          LcpRole,
          LcpAgent,
          AuditEvent,
          KnowledgeChunk,
          EpisodicMemory,
          CompanyUser,
          Conversation,
          ConversationMessage,
          PendingConsultation,
        ];
        if (!url || url.startsWith('sqlite')) {
          return {
            type: 'better-sqlite3',
            database: ':memory:',
            entities,
            synchronize: true,
          };
        }
        return {
          type: 'postgres',
          url,
          entities,
          synchronize: false,
          migrationsRun: true,
          migrations: [
            InitialSchema1750000000000,
            AddRoleAgentAudit1750000000001,
            CompanyLlmDefault1750000000002,
            AddCompanyDescription1782144931792,
            AddRolePromptCompanyContext1782246360783,
            AddCompanyEmbeddingConfig1782246974102,
            AddKnowledgeChunk1782246974122,
            AddEpisodicMemory1782247100000,
            AddCompanyUser1782247200000,
            AddConversation1782247300000,
            AddAgentOutputAndConsultation1782247400000,
            AddAgentStorageChanges1782247500000,
          ],
        };
      },
    }),
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
