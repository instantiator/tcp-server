import { EpisodicMemory, TcpCompany, TcpRole } from '@lcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';

/** Root module for lcp-mcp-memory. Wires config, TypeORM, health, and MCP tooling. */
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
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        // TcpRole is registered but never queried here — required so
        // TypeORM can resolve TcpCompany.plannerRole's target entity metadata.
        entities: [TcpCompany, TcpRole, EpisodicMemory],
        synchronize: false,
      }),
    }),
    HealthModule,
    McpModule,
  ],
})
export class AppModule {}
