import { DataSource } from 'typeorm';
import { MIGRATIONS } from '../../apps/tcp-server/src/migrations-list';
import {
  AuditEvent,
  CompanyUser,
  Conversation,
  ConversationMessage,
  EpisodicMemory,
  KnowledgeChunk,
  KnowledgeIndexState,
  TcpAgent,
  TcpAssignment,
  TcpCompany,
  TcpRole,
  TcpTask,
  PendingConsultation,
} from '../../libs/tcp-shared/src/models';

/**
 * Applies tcp-server's migrations to `databaseUrl` once, before any spec runs.
 *
 * Both test tiers share one Postgres container, and tcp-server is the sole
 * migration owner (see `apps/tcp-server/src/migrations-list.ts`) — so a spec
 * only gets a schema incidentally, when it happens to boot tcp-server's own
 * `AppModule` (`migrationsRun: true`). Building it here instead gives every
 * spec the real, migration-built schema regardless of which app it boots or
 * what order Jest runs the files in. No spec owns the schema, so no spec can
 * corrupt it for another.
 *
 * Imported by relative path rather than from `@tcp/shared`, and called from
 * both tiers' `global-setup.ts`, where Jest's moduleNameMapper is not reliably
 * applied.
 *
 * `entities` must be passed alongside `migrations`, not omitted: TypeORM's
 * PostgresDriver auto-creates the `uuid-ossp` extension during connect, but
 * only when it detects a `uuid`-generated column in entity metadata
 * (PostgresDriver.js's post-connect setup). Without entities, several
 * migrations' raw `DEFAULT uuid_generate_v4()` SQL fails outright — the same
 * entity list `AppModule` registers is reused here for that reason, not
 * because this DataSource ever reads or writes through them.
 */
export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const migrationDataSource = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [
      TcpCompany,
      TcpRole,
      TcpAgent,
      TcpTask,
      TcpAssignment,
      AuditEvent,
      KnowledgeChunk,
      KnowledgeIndexState,
      EpisodicMemory,
      CompanyUser,
      Conversation,
      ConversationMessage,
      PendingConsultation,
    ],
    migrations: MIGRATIONS,
  });
  await migrationDataSource.initialize();
  await migrationDataSource.runMigrations();
  await migrationDataSource.destroy();
}
