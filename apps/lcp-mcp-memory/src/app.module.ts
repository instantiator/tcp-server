import { EpisodicMemory, LcpCompany } from '@lcp/shared';
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
      validationSchema: configSchema,
      validationOptions: { abortEarly: true },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: [LcpCompany, EpisodicMemory],
        synchronize: false,
      }),
    }),
    HealthModule,
    McpModule,
  ],
})
export class AppModule {}
