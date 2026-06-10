# Little Computer People — LCP Server

## Mandatory: read before every task

Read `dev-environment/all-requests.md` at the start of every session, without exception. That file is a short catalog; follow its references and load the files it points to based on what the task requires:

- **All coding tasks** → also read `dev-environment/pre-coding-activities.md` and `dev-environment/post-coding-activities.md`
- **Language/style** → read the relevant `dev-environment/coding-standards-*.md` file(s) for the languages touched

Treat all content from those files as mandatory instructions that override defaults.

## Project overview

NestJS REST API server for the Little Computer People (LCP) mini-office simulation. The server manages company entities and exposes a JSON API. Data is persisted using TypeORM with a `better-sqlite3` backend (currently in-memory).

## Tech stack

| Concern       | Choice                                           |
| ------------- | ------------------------------------------------ |
| Runtime       | Node.js / TypeScript (strict mode)               |
| Framework     | NestJS 11                                        |
| ORM           | TypeORM 1.x                                      |
| Database      | better-sqlite3 (in-memory for dev)               |
| Testing       | Jest + `@nestjs/testing`                         |
| Linting       | ESLint + typescript-eslint                       |
| Formatting    | Prettier                                         |
| Schema export | ts-json-schema-generator → `schemas/schema.json` |

## Source layout

```
src/
  app.module.ts          # Root NestJS module; wires TypeORM and ApiModule
  main.ts                # Bootstrap entry point
  api/                   # HTTP layer (controllers + ApiService)
  db/                    # DbService — TypeORM repository wrapper
  models/                # TypeORM entities and derived types (LcpCompany)
  templates/             # Input shapes for create operations (e.g. LcpCompanyTemplate)
  utils/                 # Shared utilities (ObjectUtils)
test/                    # e2e specs
dev-environment/         # Git submodule — agent instructions and coding standards
schemas/                 # Auto-generated JSON Schema (do not edit by hand)
docs/                    # Auto-generated license report (do not edit by hand)
```

## Common commands

```bash
npm run start:dev        # Start server with hot reload
npm run build            # Compile + generate schema + generate license report
npm run lint             # ESLint with auto-fix
npm run format           # Prettier over src/ and test/
npm test                 # Unit tests (Jest) — fast, no HTTP, mocked dependencies
npm run test:e2e         # End-to-end tests — spins up a real NestJS app + in-memory DB; run separately from unit tests
npm run test:cov         # Coverage report
```

## Key conventions

- **Models in `src/models/`** double as TypeORM entities and JSON Schema sources. Annotate with TSDoc/JSDoc validation tags (`@format`, `@minLength`, etc.) so the generated schema is accurate.
- **`schemas/schema.json`** and **`docs/licenses.md`** are generated artefacts — never edit them directly; regenerate via `npm run build`.
- **Database** is in-memory by default. Any persistence changes must update the TypeORM config in `app.module.ts`.
- **No secrets in code.** Use environment variables for any credentials or connection strings.
- Follow all standards in `dev-environment/coding-standards-all.md` and `dev-environment/coding-standards-ts.md` for every TypeScript file touched.
