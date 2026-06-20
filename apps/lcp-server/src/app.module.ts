import { AuditEvent, LcpAgent, LcpCompany, LcpRole } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApiModule } from './api/api.module';
import { AuthModule } from './auth/auth.module';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { CompanyLlmDefault1750000000002 } from './migrations/1750000000002-CompanyLlmDefault';
import { AddRoleAgentAudit1750000000001 } from './migrations/1750000000001-AddRoleAgentAudit';
import { InitialSchema1750000000000 } from './migrations/1750000000000-InitialSchema';

/**
 * Root module for lcp-server. Wires global config validation, TypeORM,
 * the REST API, health checks, and OIDC authentication.
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
        const entities = [LcpCompany, LcpRole, LcpAgent, AuditEvent];
        if (!url || url.startsWith('sqlite')) {
          return {
            type: 'better-sqlite3',
            database: ':memory:',
            entities,
            synchronize: true,
          };
        }
        return {
          type: 'postgres',
          url,
          entities,
          synchronize: false,
          migrationsRun: true,
          migrations: [
            InitialSchema1750000000000,
            AddRoleAgentAudit1750000000001,
            CompanyLlmDefault1750000000002,
          ],
        };
      },
    }),
    ApiModule,
    HealthModule,
    AuthModule,
  ],
})
export class AppModule {}
