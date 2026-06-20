import { Module } from '@nestjs/common';
import { DbModule } from '../db/db.module';
import { ModelCheckModule } from '../model-check/model-check.module';
import { AgentController } from './api.agent.controller';
import { CompanyController } from './api.company.controller';
import { ModelController } from './api.model.controller';
import { RoleController } from './api.role.controller';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ApiService } from './api.service';

/** HTTP API module: wires all REST controllers and supporting services. */
@Module({
  imports: [DbModule, ModelCheckModule],
  controllers: [
    CompanyController,
    RoleController,
    AgentController,
    ModelController,
  ],
  providers: [ApiService, AgentOrchestrationService],
})
export class ApiModule {}
