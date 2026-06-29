import {
  AuditEvent,
  KnowledgeChunk,
  LcpAgent,
  LcpCompany,
  LcpRole,
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
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    makeTypeOrmConfig([
      LcpCompany,
      LcpRole,
      LcpAgent,
      AuditEvent,
      KnowledgeChunk,
    ]),
    HealthModule,
    AgentWorkerModule,
  ],
})
export class AppModule {}
