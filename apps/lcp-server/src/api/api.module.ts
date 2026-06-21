import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DbModule } from '../db/db.module';
import { ModelCheckModule } from '../model-check/model-check.module';
import { AgentController } from './api.agent.controller';
import { CompanyController } from './api.company.controller';
import { ModelController } from './api.model.controller';
import { RoleController } from './api.role.controller';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ApiService } from './api.service';
import { ChatService } from './chat.service';

/** HTTP API module: wires all REST controllers and supporting services. */
@Module({
  imports: [
    DbModule,
    ModelCheckModule,
    TypeOrmModule.forFeature([LcpAgent, LcpRole, LcpCompany, AuditEvent]),
  ],
  controllers: [
    CompanyController,
    RoleController,
    AgentController,
    ModelController,
  ],
  providers: [ApiService, AgentOrchestrationService, ChatService],
})
export class ApiModule {}
