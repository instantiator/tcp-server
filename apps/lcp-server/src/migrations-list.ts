import { MigrationInterface } from 'typeorm';
import { BaselineSchema1784790000000 } from './migrations/1784790000000-BaselineSchema';
import { DynamicEmbeddingDimension1784800000000 } from './migrations/1784800000000-DynamicEmbeddingDimension';

/**
 * lcp-server's full, ordered migration list — the single source of truth for
 * `AppModule` (which runs these on startup) and for the e2e test harness's
 * global setup, which migrates the shared tier Postgres once before any spec
 * runs (including specs that only ever boot other apps' `AppModule`s, which
 * never run migrations themselves — lcp-server is the sole migration owner).
 *
 * The 33 incremental migrations that built the schema up to this point were
 * squashed into {@link BaselineSchema1784790000000}, so this list starts from a
 * single `CREATE`-only baseline. Existing databases cannot be migrated onto it
 * and must be recreated. {@link DynamicEmbeddingDimension1784800000000} stays
 * separate and last because it is env-driven, not static: it resizes the vector
 * columns whenever `EMBEDDING_DIMENSION` differs from the baseline's default,
 * which is what lets the setup wizard and `set-embedding-model` change
 * dimensions after deployment.
 *
 * Deliberately lives outside `migrations/` rather than as `migrations/index.ts`:
 * `data-source.ts`'s CLI-facing migrations glob (`migrations/*.ts`) is
 * non-recursive and would otherwise re-import every class a second time
 * through this file, double-registering each migration for the TypeORM CLI.
 */
export const MIGRATIONS: (new () => MigrationInterface)[] = [
  BaselineSchema1784790000000,
  DynamicEmbeddingDimension1784800000000,
];
