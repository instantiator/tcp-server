import {
  CompanyUser,
  Conversation,
  ConversationMessage,
  LcpAgent,
  LcpCompany,
  LcpRole,
  PendingConsultation,
} from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { DbModule } from '../db/db.module';
import { ModelCheckModule } from '../model-check/model-check.module';
import { ContextModule } from '../context/context.module';
import { RagModule } from '../rag/rag.module';
import { MinioModule } from '../storage/minio.module';
import { AgentController } from './api.agent.controller';
import { CompanyController } from './api.company.controller';
import { CompanyUserController } from './company-user.controller';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { InternalController } from './internal.controller';
import { ModelController } from './api.model.controller';
import { RoleController } from './api.role.controller';
import { RoleDocumentController } from './role-document.controller';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ApiService } from './api.service';
import { ChatService } from './chat.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { RoleDocumentService } from './role-document.service';

/** HTTP API module: wires all REST controllers and supporting services. */
@Module({
  imports: [
    AuditModule,
    DbModule,
    ModelCheckModule,
    ContextModule,
    RagModule,
    MinioModule,
    TypeOrmModule.forFeature([
      LcpAgent,
      LcpRole,
      LcpCompany,
      CompanyUser,
      Conversation,
      ConversationMessage,
      PendingConsultation,
    ]),
  ],
  controllers: [
    CompanyController,
    CompanyUserController,
    ConversationController,
    InternalController,
    RoleController,
    RoleDocumentController,
    AgentController,
    ModelController,
  ],
  providers: [
    ApiService,
    AgentOrchestrationService,
    ChatService,
    ConversationService,
    PauseAndResumeService,
    RoleDocumentService,
  ],
})
export class ApiModule {}
