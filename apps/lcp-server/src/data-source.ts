/**
 * TypeORM {@link DataSource} used exclusively by the TypeORM CLI
 * (`migration:generate`, `migration:run`, `migration:revert`).
 *
 * Not imported by the NestJS runtime — {@link AppModule} constructs its own
 * connection via `TypeOrmModule.forRootAsync` with {@link ConfigService}.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['libs/lcp-shared/src/models/*.model.ts'],
  migrations: ['apps/lcp-server/src/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
});
