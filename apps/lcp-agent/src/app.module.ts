import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
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
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('DATABASE_URL') ?? '';
        if (!url || url.startsWith('sqlite')) {
          return {
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [LcpCompany, LcpRole, LcpAgent, AuditEvent],
            synchronize: true,
          };
        }
        return {
          type: 'postgres',
          url,
          entities: [LcpCompany, LcpRole, LcpAgent, AuditEvent],
          // Migrations are run by lcp-server on startup; lcp-agent only reads/writes
          synchronize: false,
          migrationsRun: false,
        };
      },
    }),
    HealthModule,
    AgentWorkerModule,
  ],
})
export class AppModule {}
