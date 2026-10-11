import { mcpConfigModule } from '@tcp/shared';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { McpModule } from './mcp/mcp.module';
import { RECORDS_MIGRATIONS } from './migrations-list';

/**
 * Root module for tcp-mcp-records. It owns its own connection and migrations,
 * because the records may live in a database of their own.
 */
@Module({
  imports: [
    mcpConfigModule(configSchema),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        // `||`, not `??`: compose passes an unset RECORDS_DATABASE_URL as ''.
        url:
          config.get<string>('RECORDS_DATABASE_URL') ||
          config.getOrThrow<string>('DATABASE_URL'),
        // Raw SQL throughout (see RecordsService), so no entities.
        entities: [],
        migrations: RECORDS_MIGRATIONS,
        migrationsRun: true,
        migrationsTableName: 'records_migrations',
        synchronize: false,
      }),
    }),
    HealthModule,
    McpModule,
  ],
})
export class AppModule {}
