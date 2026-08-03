import {
  AuditEvent,
  KnowledgeChunk,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  makeTypeOrmConfig,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { AgentWorkerModule } from './worker/agent-worker.module';

/**
 * Root module for tcp-agent. Wires config validation, TypeORM (same database
 * as tcp-server; migrations are tcp-server's responsibility), health checks,
 * and the BullMQ agent worker.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Prevents NestJS's own dotenv loading from independently reading the
      // real .env — see apps/tcp-server/src/app.module.ts for why.
      ignoreEnvFile: true,
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    makeTypeOrmConfig([
      TcpCompany,
      TcpRole,
      TcpAgent,
      // TcpAgent's mandatory assignment FK (and the assignment's task relation
      // loaded in AgentLoopService.run) require these registered too.
      TcpTask,
      TcpAssignment,
      AuditEvent,
      KnowledgeChunk,
    ]),
    HealthModule,
    AgentWorkerModule,
  ],
})
export class AppModule {}
