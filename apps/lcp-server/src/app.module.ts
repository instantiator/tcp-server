import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LcpCompany } from '@lcp/shared';
import { ApiModule } from './api/api.module';
import { configSchema } from './config/config.schema';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { InitialSchema1750000000000 } from './migrations/1750000000000-InitialSchema';

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
            entities: [LcpCompany],
            synchronize: true,
          };
        }
        return {
          type: 'postgres',
          url,
          entities: [LcpCompany],
          synchronize: false,
          migrationsRun: true,
          migrations: [InitialSchema1750000000000],
        };
      },
    }),
    ApiModule,
    HealthModule,
    AuthModule,
  ],
})
export class AppModule {}
