# ADR-022: Monorepo Workspace Structure

**Status:** Proposed (2026-07-30)

## Context

The repository is a single npm package. One root `package.json`, one
`nest-cli.json` listing seven Nest projects, one root `tsconfig.json`, and a
single multi-stage `Dockerfile` that — deliberately, per the comment at its head
— replaced six near-identical per-app Dockerfiles so that `npm ci` and the app
build run **once** and are shared across every service image.

`libs/tcp-shared` is not a package at all. It has no `package.json`; `@tcp/shared`
is purely a `tsconfig` `paths` alias, declared in ten places, plus four Jest
`moduleNameMapper` entries.

Adding a browser application breaks two assumptions in that arrangement:

1. **The shared barrel is server-only.** `libs/tcp-shared/src/index.ts`
   re-exports TypeORM entities, BullMQ and Redis clients, MinIO helpers and
   NestJS modules. A browser bundler cannot resolve much of it and should not
   bundle the rest. This is a build-breaker, not a tidiness concern.
2. **The root tooling is Node-shaped.** `eslint.config.mjs` sets
   `sourceType: 'commonjs'` and `globals.node`; the root `tsconfig.json` targets
   Node with decorators enabled. A React/TSX/browser app cannot share it.

There is one precedent for a non-Nest app under `apps/`: `tcp-stub-llm` is
excluded from root tooling at **seven** separate points (eslint `ignores`,
`.prettierignore`, Jest `testPathIgnorePatterns`, the `typecheck` script's
project list, `nest-cli.json`, `.gitignore`, and a separate Dependabot entry) —
and consequently has **zero CI coverage**. Nobody runs its install, lint,
typecheck, or tests. Repeating that pattern for the frontend would repeat the
blind spot.

Separately, the user's stated preference is that a file marking "here is an
application" should sit close to that application, rather than one manifest at
the root standing in for eight.

## Options considered

|                                      | **Full split (chosen)**                                                                       | Minimal split                                                                           | Status quo + exclusions                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Layout                               | `apps/backend/`, `apps/frontend/tcp-frontend/`, `libs/tcp-shared/` each with a `package.json` | Root keeps the Nest apps in place; only `tcp-frontend` and `tcp-shared` become packages | Frontend added under `apps/`, excluded from root tooling like `tcp-stub-llm` |
| Solves the barrel problem            | Yes, via `exports`                                                                            | Yes, via `exports`                                                                      | Only by convention                                                           |
| CI coverage for the frontend         | Yes                                                                                           | Yes                                                                                     | No — inherits the `tcp-stub-llm` blind spot                                  |
| Matches the stated layout preference | Yes                                                                                           | Partly                                                                                  | No                                                                           |
| Migration cost                       | High — see below                                                                              | Low                                                                                     | Very low                                                                     |

The full split's cost is concentrated entirely in relocating the six Nest apps,
and it is not small:

- nine hardcoded `-p apps/<name>/tsconfig*.json` paths in the root `typecheck` script
- seven `tsconfig.app.json` files whose `../../` prefixes each gain a level
- `nest-cli.json`'s per-project `root` / `sourceRoot` / `tsConfigPath`
- `scripts/hooks/pre-push`'s migration-drift regex, which hardcodes
  `apps/tcp-server/src/migrations/` and **fails open** — it stops firing silently
- Jest `roots` and `testPathIgnorePatterns`; eslint globs; `.prettierignore`
- `.github/dependabot.yml`; CI's `cache-dependency-path`
- the `Dockerfile` builder stage and `docker-compose.yml` bake targets

## Decision

**Adopt npm workspaces with three members: `apps/backend`,
`apps/frontend/tcp-frontend`, and `libs/tcp-shared`.**

The full split is chosen over the minimal one because the stated goal is the
layout itself, not only the barrel fix. The cost above is a one-off migration
with a mechanical checklist; the layout is permanent. It is recorded here so the
migration is scoped deliberately rather than discovered halfway through.

### The root `package.json` shrinks but does not disappear

npm workspaces require a root manifest. It keeps `"workspaces"`, the lockfile,
and the genuinely cross-cutting scripts that have nowhere else to live —
`schema:generate` and `licenses:generate` (both read across `apps/` and `libs/`),
the migration commands, and the hook installer. Everything app-specific moves
into its workspace.

`nest-cli.json` moves to `apps/backend/`, alongside the manifest describing the
projects it configures. The Nest CLI resolves it relative to the working
directory, so `npm run build --workspace apps/backend` finds it.

### `tcp-shared` becomes a package, and its `exports` map is the enforcement

```jsonc
{
  "name": "@tcp/shared",
  "private": true,
  "exports": {
    ".": "./src/index.ts", // full server-side surface
    "./client": "./src/client.ts", // DTOs, WireEvent, pure parsers only
  },
}
```

`./client` re-exports only what a browser can safely receive: the model types
used as DTOs, the `WireEvent` union and its summary helpers, and the pure stream
parsers moved over from `tcp-cli`. No entity decorators, no service classes, no
Node built-ins.

Enforcement is layered, deliberately:

1. The frontend's `tsconfig.json` declares **no** `@tcp/shared` path alias — only
   `@tcp/shared/client`.
2. The frontend's eslint config adds `no-restricted-imports` for the bare
   specifier, with a message naming `@tcp/shared/client` as the replacement.
3. Failing both, Vite fails the build when it meets `typeorm` or `ioredis`.

The third layer already makes this fail-fast; the first two make it fail
_legibly_, at edit time, with an actionable message instead of a bundler stack
trace.

### `tcp-shared` stays symlinked source; it does not gain a build step

The backend consumes it through webpack (`nest build`) and the frontend through
Vite. Both compile TypeScript. Introducing a `tsc` build would add an artefact,
an ordering constraint, and a stale-output failure mode, in exchange for
nothing either consumer needs.

### The Dockerfile keeps its single-install shape — this is a constraint, not a goal

`npm ci` at a workspace root resolves and hoists the entire workspace graph in
**one** pass; it does not run once per member. The builder stage therefore keeps
its shape, and only the cached copy layer widens:

```dockerfile
COPY package*.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/tcp-frontend/package.json ./apps/frontend/tcp-frontend/
COPY libs/tcp-shared/package.json ./libs/tcp-shared/
RUN --mount=type=cache,target=/root/.npm npm ci
```

The layer still invalidates only when a manifest changes. `builder` and
`prod-deps` remain shared across all service targets.

The frontend's runtime image is **simpler** than the six Node services, not an
additional build path: it is static assets served by nginx, so it copies from
`builder` and needs neither `node_modules` nor a Node runtime
([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).

## Consequences

- A one-off migration touching roughly fifteen configuration surfaces. It must
  land as its own change, with the checklist above worked through explicitly —
  not folded into the frontend scaffold.
- **`scripts/hooks/pre-push`'s migration-drift regex fails open.** If its path is
  not updated, the guard stops firing and nothing reports it. This is the single
  most dangerous item on the list precisely because its failure is silent.
- `npm ci --omit=dev` at the root installs prod dependencies for every
  workspace, so each backend image carries the frontend's few prod deps. A few
  MB, and already true today across the six services sharing one
  `node_modules`. Scoping with `--workspace` would avoid it and is not required.
- CI's `setup-node` currently has no `cache-dependency-path` and hashes
  `**/package-lock.json`. Adding manifests changes the cache key; an explicit
  path becomes worth setting.
- The frontend gains real CI coverage — install, lint, typecheck, test — rather
  than inheriting `tcp-stub-llm`'s blind spot. Bringing `tcp-stub-llm` itself in
  as a fourth workspace is now cheap, and is **out of scope here**: it has its
  own TypeScript major and its own eslint config, and mixing that into this
  migration would confuse two independent problems.
- `libs/tcp-shared` gaining a `package.json` does not remove the ten `tsconfig`
  path declarations or four Jest mappers. They keep working; converging on
  workspace resolution is optional follow-up, not part of this change.

## Alternatives considered

- **Minimal split** — `tcp-shared` and the frontend become packages, the six Nest
  apps stay put. Delivers the entire build-breaking fix (the `exports` split) and
  full frontend CI for a fraction of the cost, since every item in the cost list
  above is caused by relocating the Nest apps. Rejected only because the layout
  is itself a goal; it remains the fallback if the migration proves disruptive.
- **Repeat the `tcp-stub-llm` pattern** — add the frontend under `apps/` with
  seven exclusions and no workspace machinery. Cheapest, and rejected: it
  reproduces a known blind spot, on a larger application, and leaves the barrel
  split unenforced.
- **Nx or Turborepo.** Real caching and task-graph wins at this size. Rejected:
  a build orchestrator is a much larger change than the problem needs, and the
  single-`npm ci` Dockerfile already delivers the sharing that matters here.

## Prompts to update when this is decided

- `002.00.00.prompt - monorepo restructuring (draft).md`
- `002.01.00.prompt - application infrastructure (draft).md`
- `002.02.00.prompt - testing infrastructure (draft).md`
- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `005.02.00.prompt - sse client and event handling (draft).md`
