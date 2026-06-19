# Database Migrations

LCP uses TypeORM migrations to manage the PostgreSQL schema. Migrations are never
run against SQLite (the in-memory fallback used by unit and e2e tests), which uses
`synchronize: true` instead.

## How migrations run at startup

`AppModule` passes `migrationsRun: true` to TypeORM when `DATABASE_URL` points to
PostgreSQL. This means every pending migration runs automatically on lcp-server
startup — you don't need to run them separately in most cases.

Each migration that has run is recorded in the `typeorm_migrations` table so it is
only ever applied once.

## Adding a migration

Do this whenever you change or add a TypeORM entity in `libs/lcp-shared/src/models/`.

### 1. Make the entity change

Edit the model in `libs/lcp-shared/src/models/`. Commit nothing yet.

### 2. Generate the migration

Point `DATABASE_URL` at a running PostgreSQL instance (e.g. `docker compose up -d postgres`)
and run:

```bash
DATABASE_URL=postgres://lcp:dev-password@localhost:5432/lcp \
  npm run migration:generate -- apps/lcp-server/src/migrations/DescriptiveName
```

TypeORM compares the current database schema against the entity definitions and writes
a new file to `apps/lcp-server/src/migrations/`.

### 3. Review the generated file

Open the generated migration and check:

- The `up()` method makes exactly the structural changes you intended.
- The `down()` method correctly reverses them.
- No unexpected `DROP COLUMN` or `DROP TABLE` statements (these appear when TypeORM
  notices schema drift from a previous `synchronize: true` run).

### 4. Register the migration class in AppModule

TypeORM is built with webpack, so glob patterns (`*.js`) cannot be used at runtime —
every migration class must be imported explicitly.

Open `apps/lcp-server/src/app.module.ts` and add the new class to the `migrations` array:

```typescript
import { InitialSchema1750000000000 } from './migrations/1750000000000-InitialSchema';
import { AddCompanyRegion1750000001000 } from './migrations/1750000001000-AddCompanyRegion'; // new

// inside TypeOrmModule.forRootAsync → postgres branch:
migrations: [InitialSchema1750000000000, AddCompanyRegion1750000001000],
```

### 5. Commit both files together

Always commit the entity change and the migration file as a single commit so the
repository is never in a state where the entity and the schema disagree.

```bash
git add libs/lcp-shared/src/models/LcpCompany.model.ts \
        apps/lcp-server/src/migrations/<timestamp>-DescriptiveName.ts \
        apps/lcp-server/src/app.module.ts
git commit -m "Add region column to lcp_company"
```

## Running migrations manually

In most cases `migrationsRun: true` handles this on startup. For exceptional cases:

```bash
# Apply all pending migrations without restarting lcp-server
DATABASE_URL=postgres://lcp:dev-password@localhost:5432/lcp npm run migration:run

# Roll back the most recently applied migration
DATABASE_URL=postgres://lcp:dev-password@localhost:5432/lcp npm run migration:revert
```

`migration:revert` only rolls back one migration at a time; run it repeatedly to
revert multiple steps.

## Rules

- **Never use `synchronize: true` with PostgreSQL.** TypeORM silently drops columns
  that no longer exist on the entity — a production data loss risk.
- **Always commit the entity and migration together.** A migration without an entity
  change (or vice versa) leaves the codebase in an inconsistent state.
- **Always register new migration classes in `app.module.ts`.** Globs do not work in
  the webpack bundle. Forgetting this means the migration will never run.
- **Never edit a migration that has already been applied** to a shared environment.
  Create a new migration to correct it instead.
