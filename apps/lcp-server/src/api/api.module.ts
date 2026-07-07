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
import { McpClientModule } from '../mcp/mcp-client.module';
import { ModelCheckModule } from '../model-check/model-check.module';
import { ContextModule } from '../context/context.module';
import { RagModule } from '../rag/rag.module';
import { StorageModule } from '../storage/storage.module';
import { AgentController } from './api.agent.controller';
import { CompanyController } from './api.company.controller';
import { CompanyUserController } from './company-user.controller';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { InternalController } from './internal.controller';
import { ModelController } from './api.model.controller';
import { RoleController } from './api.role.controller';
import { RoleDocumentController } from './role-document.controller';
import { StorageActionsController } from './storage-actions.controller';
import { StorageProxyController } from './storage-proxy.controller';
import { StorageValidationController } from './storage-validation.controller';
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
    McpClientModule,
    ModelCheckModule,
    ContextModule,
    RagModule,
    StorageModule,
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
    StorageActionsController,
    StorageProxyController,
    StorageValidationController,
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
