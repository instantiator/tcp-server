import { ConfigModule, ConfigService } from '@nestjs/config';
import { DynamicModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EntityClassOrSchema } from '@nestjs/typeorm/dist/interfaces/entity-class-or-schema.type';
import { MigrationInterface } from 'typeorm';

/**
 * Returns a `TypeOrmModule.forRootAsync(...)` dynamic module for use directly
 * in an app's `imports` array.
 *
 * When `DATABASE_URL` is absent or begins with `sqlite`, returns a
 * better-sqlite3 in-memory config with `synchronize: true` so unit and E2E
 * tests work without a running database. In all other cases returns a postgres
 * config with migrations disabled by default. Pass `migrations` to enable
 * migration-on-startup (tcp-server only).
 */
export function makeTypeOrmConfig(
  entities: EntityClassOrSchema[],
  migrations?: (new () => MigrationInterface)[],
): DynamicModule {
  return TypeOrmModule.forRootAsync({
    imports: [ConfigModule],
    inject: [ConfigService],
    useFactory: (config: ConfigService) => {
      const url = config.get<string>('DATABASE_URL') ?? '';
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
        migrationsRun: !!migrations?.length,
        ...(migrations?.length ? { migrations } : {}),
      };
    },
  });
}
