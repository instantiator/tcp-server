// Used by TypeORM CLI only (migration:generate, migration:run, migration:revert).
// Not imported by the NestJS runtime — AppModule uses forRootAsync with ConfigService instead.
import 'reflect-metadata';
import { DataSource } from 'typeorm';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: ['apps/lcp-server/src/**/*.model.ts'],
  migrations: ['apps/lcp-server/src/migrations/*.ts'],
  migrationsTableName: 'typeorm_migrations',
});
