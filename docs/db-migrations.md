# Database Migrations

TCP uses TypeORM migrations to manage the PostgreSQL schema. Migrations are never
run against SQLite (the in-memory fallback used by unit and e2e tests), which uses
`synchronize: true` instead.

## How migrations run at startup

`AppModule` passes `migrationsRun: true` to TypeORM when `DATABASE_URL` points to
PostgreSQL. This means every pending migration runs automatically on tcp-server
startup — you don't need to run them separately in most cases.

Each migration that has run is recorded in the `typeorm_migrations` table so it is
only ever applied once.

## Adding a migration

Do this whenever you change or add a TypeORM entity in `libs/tcp-shared/src/models/`.

### 1. Make the entity change

Edit the model in `libs/tcp-shared/src/models/`. Commit nothing yet.

### 2. Generate the migration

Point `DATABASE_URL` at a running PostgreSQL instance (e.g. `docker compose up -d postgres`) and run:

```bash
DATABASE_URL=postgres://tcp:dev-password@localhost:5432/tcp \
  npm run migration:generate -- apps/tcp-server/src/migrations/DescriptiveName
```

eg.

```bash
DATABASE_URL=postgres://tcp:dev-password@localhost:5432/tcp \
  npm run migration:generate -- apps/tcp-server/src/migrations/AddCompanyDescription
```

TypeORM compares the current database schema against the entity definitions and writes a new file to `apps/tcp-server/src/migrations/`.

### 3. Review the generated file

Open the generated migration and check:

- Change `import { MigrationInterface, QueryRunner }` to
  `import type { MigrationInterface, QueryRunner }` — the generator emits a value
  import but both are TypeScript interfaces with no runtime representation.
- The `up()` method makes exactly the structural changes you intended.
- The `down()` method correctly reverses them.
- No unexpected `DROP COLUMN` or `DROP TABLE` statements (these appear when TypeORM
  notices schema drift from a previous `synchronize: true` run).

### 4. Register the migration class in migrations-list.ts

TypeORM is built with webpack, so glob patterns (`*.js`) cannot be used at runtime —
every migration class must be imported explicitly.

Open `apps/tcp-server/src/migrations-list.ts` and add the new class to the ordered
`MIGRATIONS` array (`AppModule` and the e2e global setup both read it from there):

```typescript
import { BaselineSchema1784790000000 } from './migrations/1784790000000-BaselineSchema';
import { DynamicEmbeddingDimension1784800000000 } from './migrations/1784800000000-DynamicEmbeddingDimension';
import { AddCompanyRegion1785000000000 } from './migrations/1785000000000-AddCompanyRegion'; // new

export const MIGRATIONS: (new () => MigrationInterface)[] = [
  BaselineSchema1784790000000,
  DynamicEmbeddingDimension1784800000000,
  AddCompanyRegion1785000000000,
];
```

### 5. Commit both files together

Always commit the entity change and the migration file as a single commit so the
repository is never in a state where the entity and the schema disagree.

```bash
git add libs/tcp-shared/src/models/TcpCompany.model.ts \
        apps/tcp-server/src/migrations/<timestamp>-DescriptiveName.ts \
        apps/tcp-server/src/migrations-list.ts
git commit -m "Add region column to tcp_company"
```

## Running migrations manually

In most cases `migrationsRun: true` handles this on startup. For exceptional cases:

```bash
# Apply all pending migrations without restarting tcp-server
DATABASE_URL=postgres://tcp:dev-password@localhost:5432/tcp npm run migration:run

# Roll back the most recently applied migration
DATABASE_URL=postgres://tcp:dev-password@localhost:5432/tcp npm run migration:revert
```

`migration:revert` only rolls back one migration at a time; run it repeatedly to
revert multiple steps.

## Rules

- **Never use `synchronize: true` with PostgreSQL.** TypeORM silently drops columns
  that no longer exist on the entity — a production data loss risk.
- **Always commit the entity and migration together.** A migration without an entity
  change (or vice versa) leaves the codebase in an inconsistent state.
- **Always register new migration classes in `migrations-list.ts`.** Globs do not work in
  the webpack bundle. Forgetting this means the migration will never run — and the
  TypeORM CLI's own `data-source.ts` uses a glob, so it will happily run a migration
  the deployed app never sees.
- **Never edit a migration that has already been applied** to a shared environment.
  Create a new migration to correct it instead.
