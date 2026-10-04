import {
  CompanyUser,
  Conversation,
  ConversationMessage,
  KnowledgeChunk,
  KnowledgeIndexState,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  PendingConsultation,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { McpClientModule } from '../mcp/mcp-client.module';
import { NotificationModule } from '../notifications/notification.module';
import { ModelCheckModule } from '../model-check/model-check.module';
import { ContextModule } from '../context/context.module';
import { RagModule } from '../rag/rag.module';
import { StorageModule } from '../storage/storage.module';
import { AgentController } from './api.agent.controller';
import { AssignmentController } from './assignment.controller';
import { CompanyController } from './api.company.controller';
import { CompanyPrimingService } from './company-priming.service';
import { CompanyStatsService } from './company-stats.service';
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
import { SystemController } from './system.controller';
import { TaskController } from './task.controller';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ApiService } from './api.service';
import { AssignmentCompletionService } from './assignment-completion.service';
import { AssignmentService } from './assignment.service';
import { ChatService } from './chat.service';
import { ChatTurnEnvironmentService } from './chat-turn-environment.service';
import { ChatTurnPromptService } from './chat-turn-prompt.service';
import { KnowledgeService } from './knowledge.service';
import { OutputGateService } from './output-gate.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { PlanValidationService } from './plan-validation.service';
import { StorageScopeService } from './storage-scope.service';
import { SystemDrainService } from './system-drain.service';
import { SystemShutdownService } from './system-shutdown.service';
import { QaVerdictService } from './qa-verdict.service';
import { TaskDeliverablesService } from './task-deliverables.service';
import { TaskDispatcher } from './task-dispatcher.service';
import { TaskFailureService } from './task-failure.service';
import { TaskOrchestrationService } from './task-orchestration.service';
import { TaskRecoveryService } from './task-recovery.service';
import { TaskStateService } from './task-state.service';
import { TaskService } from './task.service';

/** HTTP API module: wires all REST controllers and supporting services. */
@Module({
  imports: [
    AuditModule,
    // CompanyMembershipGuard is injected into every user-facing controller.
    AuthModule,
    DbModule,
    McpClientModule,
    ModelCheckModule,
    // Company priming replays the active notifications.
    NotificationModule,
    ContextModule,
    RagModule,
    StorageModule,
    TypeOrmModule.forFeature([
      TcpAgent,
      TcpAssignment,
      TcpRole,
      TcpCompany,
      TcpTask,
      CompanyUser,
      Conversation,
      ConversationMessage,
      PendingConsultation,
      KnowledgeChunk,
      KnowledgeIndexState,
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
    SystemController,
    TaskController,
    AgentController,
    ModelController,
  ],
  providers: [
    ApiService,
    AgentOrchestrationService,
    AssignmentService,
    AssignmentCompletionService,
    OutputGateService,
    PlanValidationService,
    StorageScopeService,
    ChatService,
    ChatTurnEnvironmentService,
    ChatTurnPromptService,
    ConversationService,
    CompanyStatsService,
    CompanyPrimingService,
    KnowledgeService,
    PauseAndResumeService,
    // The drain executes shutdowns; the shutdown service holds the state every
    // intake path guards on.
    SystemShutdownService,
    SystemDrainService,
    // The orchestration stack: TaskOrchestrationService drives a task forward,
    // delegating status writes, artifact promotion, QA verdicts, failure
    // propagation and startup repair to the collaborators below.
    TaskOrchestrationService,
    TaskStateService,
    TaskDeliverablesService,
    QaVerdictService,
    TaskFailureService,
    TaskRecoveryService,
    // The real dispatcher: TaskDispatcher (the token the transition services
    // inject) resolves to the single TaskOrchestrationService instance.
    { provide: TaskDispatcher, useExisting: TaskOrchestrationService },
    TaskService,
  ],
})
export class ApiModule {}
