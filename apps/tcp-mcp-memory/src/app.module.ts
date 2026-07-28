import {
  EpisodicMemory,
  TcpCompany,
  TcpRole,
  mcpConfigModule,
} from '@tcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';

/** Root module for tcp-mcp-memory. Wires config, TypeORM, health, and MCP tooling. */
@Module({
  imports: [
    mcpConfigModule(configSchema),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        // TcpRole is queried to resolve role names for the audit trail, and is
        // required regardless so TypeORM can resolve TcpCompany.plannerRole's
        // target entity metadata.
        entities: [TcpCompany, TcpRole, EpisodicMemory],
        synchronize: false,
      }),
    }),
    HealthModule,
    McpModule,
  ],
})
export class AppModule {}
