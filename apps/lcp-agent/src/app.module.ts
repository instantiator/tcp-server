import {
  AuditEvent,
  KnowledgeChunk,
  LcpAgent,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  makeTypeOrmConfig,
} from '@lcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { AgentWorkerModule } from './worker/agent-worker.module';

/**
 * Root module for lcp-agent. Wires config validation, TypeORM (same database
 * as lcp-server; migrations are lcp-server's responsibility), health checks,
 * and the BullMQ agent worker.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Prevents NestJS's own dotenv loading from independently reading the
      // real .env — see apps/lcp-server/src/app.module.ts for why.
      ignoreEnvFile: true,
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    makeTypeOrmConfig([
      LcpCompany,
      LcpRole,
      LcpAgent,
      // LcpAgent's mandatory assignment FK (and the assignment's task relation
      // loaded in AgentLoopService.run) require these registered too.
      LcpTask,
      LcpAssignment,
      AuditEvent,
      KnowledgeChunk,
    ]),
    HealthModule,
    AgentWorkerModule,
  ],
})
export class AppModule {}
