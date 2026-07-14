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
import { AddRunConfig1782247600000 } from './migrations/1782247600000-AddRunConfig';
import { AddVersionColumns1782247700000 } from './migrations/1782247700000-AddVersionColumns';
import { AddAgentPausedAt1782831650682 } from './migrations/1782831650682-AddAgentPausedAt';
import { AddAgentRequiredToolCalls1783007161076 } from './migrations/1783007161076-AddAgentRequiredToolCalls';
import { CompanyLlmConfigAndPromptFields1783357408215 } from './migrations/1783357408215-CompanyLlmConfigAndPromptFields';
import { TimestamptzConsistency1783357408216 } from './migrations/1783357408216-TimestamptzConsistency';
import { AddRoleSlug1783357408217 } from './migrations/1783357408217-AddRoleSlug';
import { AddMissingCompanyRoleForeignKeys1783357408218 } from './migrations/1783357408218-AddMissingCompanyRoleForeignKeys';
import { AllowSharedKnowledgeChunks1783900000000 } from './migrations/1783900000000-AllowSharedKnowledgeChunks';
import { AddKnowledgeIndexState1783950000000 } from './migrations/1783950000000-AddKnowledgeIndexState';
import { AddLcpTask1784050000000 } from './migrations/1784050000000-AddLcpTask';
import { AddLcpAssignment1784050000001 } from './migrations/1784050000001-AddLcpAssignment';
import { AddCompanyPlannerRole1784050000002 } from './migrations/1784050000002-AddCompanyPlannerRole';
import { AddAgentAssignment1784050000003 } from './migrations/1784050000003-AddAgentAssignment';
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
      [
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
        AddRunConfig1782247600000,
        AddVersionColumns1782247700000,
        AddAgentPausedAt1782831650682,
        AddAgentRequiredToolCalls1783007161076,
        CompanyLlmConfigAndPromptFields1783357408215,
        TimestamptzConsistency1783357408216,
        AddRoleSlug1783357408217,
        AddMissingCompanyRoleForeignKeys1783357408218,
        AllowSharedKnowledgeChunks1783900000000,
        AddKnowledgeIndexState1783950000000,
        AddLcpTask1784050000000,
        AddLcpAssignment1784050000001,
        AddCompanyPlannerRole1784050000002,
        AddAgentAssignment1784050000003,
      ],
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
