/**
 * TypeORM {@link DataSource} used exclusively by the TypeORM CLI
 * (`migration:generate`, `migration:run`, `migration:revert`).
 *
 * Not imported by the NestJS runtime — {@link AppModule} constructs its own
 * connection via `TypeOrmModule.forRootAsync` with {@link ConfigService}.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';

// These globs are resolved against the CWD, not this file — the `migration:*`
// scripts they serve are declared in the ROOT package.json and always run from
// the repository root. Keep them repo-root-relative.
export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['libs/tcp-shared/src/models/*.model.ts'],
  migrations: ['apps/backend/apps/tcp-server/src/migrations/*.ts'],
});
