import {
  CompanyUser,
  Conversation,
  ConversationMessage,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
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
import { AssignmentController } from './assignment.controller';
import { CompanyController } from './api.company.controller';
import { CompanyUserController } from './company-user.controller';
import { ConversationController } from './conversation.controller';
import { ConversationService } from './conversation.service';
import { InternalController } from './internal.controller';
import { InternalTaskController } from './internal-task.controller';
import { KnowledgeController } from './knowledge.controller';
import { ModelController } from './api.model.controller';
import { RoleController } from './api.role.controller';
import { StorageActionsController } from './storage-actions.controller';
import { StorageProxyController } from './storage-proxy.controller';
import { StorageValidationController } from './storage-validation.controller';
import { TaskController } from './task.controller';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ApiService } from './api.service';
import { AssignmentService } from './assignment.service';
import { ChatService } from './chat.service';
import { KnowledgeService } from './knowledge.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';
import { TaskOrchestrationService } from './task-orchestration.service';
import { TaskService } from './task.service';

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
      LcpAssignment,
      LcpRole,
      LcpCompany,
      LcpTask,
      CompanyUser,
      Conversation,
      ConversationMessage,
      PendingConsultation,
    ]),
  ],
  controllers: [
    AssignmentController,
    CompanyController,
    CompanyUserController,
    ConversationController,
    InternalController,
    InternalTaskController,
    KnowledgeController,
    RoleController,
    StorageActionsController,
    StorageProxyController,
    StorageValidationController,
    TaskController,
    AgentController,
    ModelController,
  ],
  providers: [
    ApiService,
    AgentOrchestrationService,
    AssignmentService,
    ChatService,
    ConversationService,
    KnowledgeService,
    PauseAndResumeService,
    TaskOrchestrationService,
    // The real dispatcher: TaskDispatcher (the token the transition services
    // inject) resolves to the single TaskOrchestrationService instance.
    { provide: TaskDispatcher, useExisting: TaskOrchestrationService },
    TaskService,
  ],
})
export class ApiModule {}
