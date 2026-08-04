# ADR-022: Monorepo Workspace Structure

**Status:** Implemented (amended — see [Amendments](#amendments-as-implemented-00200) at the end)

## Context

The repository is currently a single npm package, with:

- 1 root `package.json`
- 1 `nest-cli.json` (listing 7 Nest projects)
- 1 root `tsconfig.json`
- a single multi-stage `Dockerfile` that, deliberately, replaces 6 near-identical per-app Dockerfiles so that `npm ci` and the app build run **once** and are shared across every service image

`libs/tcp-shared` is not a package at all (and has no `package.json`). `@tcp/shared` is just a `tsconfig` `paths` alias, declared in 10 places, and 4 Jest `moduleNameMapper` entries.

## What needs deciding

Where a browser application lives in this layout, and how it is kept out of the server-only code.

Adding a browser application breaks 2 assumptions:

1. **The shared barrel[^barrel] is server-only.** `libs/tcp-shared/src/index.ts` re-exports TypeORM entities, BullMQ and Redis clients, MinIO helpers and NestJS modules. A browser bundler cannot resolve much of it, and should not bundle the rest. This will break the build.

2. **The root tooling is for Node.** `eslint.config.mjs` sets `sourceType: 'commonjs'` and `globals.node`; the root `tsconfig.json` targets Node with decorators enabled. A React/TSX/browser app cannot share it.

There is 1 non-Nest app: `tcp-stub-llm` is excluded from the root tooling — and at the time of writing had no CI coverage. Its install, lint, typecheck, and tests weren't run. That was an oversight, and shouldn't be repeated for the frontend. (Closed later without becoming a workspace: the root `lint`, `lint:check`, `typecheck` and `format`/`format:check` scripts each gained a chained `npm --prefix apps/tcp-stub-llm run <script>` call, a root `postinstall` runs `npm ci --prefix apps/tcp-stub-llm`, and `scripts/run-unit-tests.sh` runs its `node --test` suite as a separate step since Jest passthrough args don't apply to it. This also required dropping its `typescript` devDependency from `^7.0.2` to `~6.0.3` — `typescript-eslint@8.65.0`'s peer range caps at `<6.1.0`, so a clean install was failing.)

This is also a style preference: files that are linked to an application should be close to the application, rather than in a single manifest at the root.

[^barrel]: A "barrel" is a single file that re-exports everything in a library, so consumers can import from one place. Convenient on the server; a problem in a browser, where it drags in code that cannot run there.

## Options considered

|                                      | **Full split (chosen)**                                                                       | Minimal split                                                                           | Status quo + exclusions                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Layout                               | `apps/backend/`, `apps/frontend/tcp-frontend/`, `libs/tcp-shared/` each with a `package.json` | Root keeps the Nest apps in place; only `tcp-frontend` and `tcp-shared` become packages | Frontend added under `apps/`, excluded from root tooling like `tcp-stub-llm` |
| Solves the barrel problem            | Yes, via `exports`                                                                            | Yes, via `exports`                                                                      | Only by convention                                                           |
| CI coverage for the frontend         | Yes                                                                                           | Yes                                                                                     | No — inherits the same gap in coverage that `tcp-stub-llm` has               |
| Matches the stated layout preference | Yes                                                                                           | Partly                                                                                  | No                                                                           |
| Migration cost                       | High — see [migration cost](#migration-cost)                                                  | Low                                                                                     | Very low                                                                     |

## Decision

**Adopt npm workspaces[^workspaces] with three members: `apps/backend`, `apps/frontend/tcp-frontend`, and `libs/tcp-shared`.**

The full split is preferred over the minimal one, because the stated goal is the layout itself (not only the barrel fix). The cost is a one-off migration with a mechanical checklist; the layout is permanent. It is recorded here so the migration is scoped deliberately rather than discovered halfway through.

- The root `package.json` shrinks but [does not disappear](#the-root-packagejson-shrinks-but-does-not-disappear) — npm workspaces require it.
- `tcp-shared` becomes a package, and [its `exports` map is what keeps server-only code out of the browser](#tcp-shared-becomes-a-package-and-its-exports-map-is-the-enforcement).
- `tcp-shared` [stays as source](#tcp-shared-stays-symlinked-source) and does not gain a build step.
- The Dockerfile [keeps its single-install shape](#the-dockerfile-keeps-its-single-install-shape). This is a constraint, not a goal.

[^workspaces]: npm workspaces let one repository hold several packages that share a single install and lockfile. `npm ci` still runs once for all of them.

## Consequences

- A one-off migration touching roughly fifteen configuration surfaces (see [migration cost](#migration-cost)). It must land as its own change, worked through explicitly — not folded into the frontend scaffold.
- **`scripts/hooks/pre-push`'s migration-drift regex fails open.** If its path is not updated, the guard stops firing and nothing reports it. This is the single most dangerous item on the list precisely because its failure is silent. (Verified in 002.00 — see [Amendments](#amendments-as-implemented-00200).)
- `npm ci --omit=dev` at the root installs prod dependencies for every workspace, so each backend image carries the frontend's few prod deps. A few MB, and already true today across the six services sharing one `node_modules`. Scoping with `--workspace` would avoid it and is not required.
- CI's `setup-node` currently has no `cache-dependency-path` and hashes `**/package-lock.json`. Adding manifests changes the cache key; an explicit path becomes worth setting.
- The frontend gains real CI coverage — install, lint, typecheck, test — rather than inheriting `tcp-stub-llm`'s gap in coverage. Bringing `tcp-stub-llm` itself in as a fourth workspace is now cheap, and is **out of scope here**: it has its own TypeScript major and its own eslint config, and mixing that into this migration would confuse two independent problems.
- `libs/tcp-shared` gaining a `package.json` does not remove the ten `tsconfig` path declarations or four Jest mappers. They keep working; converging on workspace resolution is optional follow-up, not part of this change.

## Alternatives considered

- **Minimal split** — `tcp-shared` and the frontend become packages, the six Nest apps stay put. Delivers the entire build-breaking fix (the `exports` split) and full frontend CI for a fraction of the cost, since every item in the cost list is caused by relocating the Nest apps. Rejected only because the layout is itself a goal; it remains the fallback if the migration proves disruptive.
- **Repeat the `tcp-stub-llm` pattern** — add the frontend under `apps/` with seven exclusions and no workspace machinery. Cheapest, and rejected: it reproduces a known gap in coverage, on a larger application, and leaves the barrel split unenforced.
- **Nx or Turborepo.** Real caching and task-graph wins at this size. Rejected: a build orchestrator is a much larger change than the problem needs, and the single-`npm ci` Dockerfile already delivers the sharing that matters here.

## Prompts to update when this is decided

- `002.00.00.prompt - monorepo restructuring.md`
- `002.01.00.prompt - application infrastructure.md`
- `002.02.00.prompt - testing infrastructure (draft).md`
- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `005.02.00.prompt - sse client and event handling (draft).md`

## Detail

### Migration cost

The full split's cost comes from the need to relocate the Nest apps. It is not small:

- 9 hardcoded `-p apps/<name>/tsconfig*.json` paths in the root `typecheck` script
- 7 `tsconfig.app.json` files whose `../../` prefixes each gain a level
- `nest-cli.json`'s per-project `root` / `sourceRoot` / `tsConfigPath`
- `scripts/hooks/pre-push`'s migration-drift regex, which hardcodes `apps/tcp-server/src/migrations/` and **fails open** — it stops firing silently
- Jest `roots` and `testPathIgnorePatterns`; eslint globs; `.prettierignore`
- `.github/dependabot.yml`; CI's `cache-dependency-path`
- the `Dockerfile` builder stage and `docker-compose.yml` bake targets

### The root `package.json` shrinks but does not disappear

npm workspaces require a root manifest. It keeps `"workspaces"`, the lockfile, and the genuinely cross-cutting scripts that have nowhere else to live — `schema:generate` and `licenses:generate` (both read across `apps/` and `libs/`), the migration commands, and the hook installer. Everything app-specific moves into its workspace.

`nest-cli.json` moves to `apps/backend/`, alongside the manifest describing the projects it configures. The Nest CLI resolves it relative to the working directory, so `npm run build --workspace apps/backend` finds it.

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

`./client` re-exports only what a browser can safely receive: the model types used as DTOs, the `WireEvent` union and its summary helpers, and the pure stream parsers moved over from `tcp-cli`. No entity decorators, no service classes, no Node built-ins.

Enforcement is layered, deliberately:

1. The frontend's `tsconfig.json` declares **no** `@tcp/shared` path alias — only `@tcp/shared/client`.
2. The frontend's eslint config adds `no-restricted-imports` for the bare specifier, with a message naming `@tcp/shared/client` as the replacement.
3. Failing both, Vite fails the build when it meets `typeorm` or `ioredis`.

The third layer already makes this fail-fast; the first two make it fail _legibly_, at edit time, with an actionable message instead of a bundler stack trace.

### `tcp-shared` stays symlinked source

The backend consumes it through webpack (`nest build`) and the frontend through Vite. Both compile TypeScript. Introducing a `tsc` build would add an artefact, an ordering constraint, and a stale-output failure mode, in exchange for nothing either consumer needs.

### The Dockerfile keeps its single-install shape

`npm ci` at a workspace root resolves and hoists the entire workspace graph in **one** pass; it does not run once per member. The builder stage therefore keeps its shape, and only the cached copy layer widens:

```dockerfile
COPY package*.json ./
COPY apps/backend/package.json ./apps/backend/
COPY apps/frontend/tcp-frontend/package.json ./apps/frontend/tcp-frontend/
COPY libs/tcp-shared/package.json ./libs/tcp-shared/
RUN --mount=type=cache,target=/root/.npm npm ci
```

The layer still invalidates only when a manifest changes. `builder` and `prod-deps` remain shared across all service targets.

The frontend's runtime image is **simpler** than the six Node services, not an additional build path: it is static assets served by nginx, so it copies from `builder` and needs neither `node_modules` nor a Node runtime ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).

## Amendments as implemented (002.00) <a id="amendments-as-implemented-00200"></a>

The migration landed as described. Five things this ADR left open or got wrong:

- **The Nest apps nest one level deeper than the shorthand suggests: `apps/backend/apps/<name>/`.** Chosen over a flatter `apps/backend/<name>/` because it leaves `nest-cli.json`'s seven project roots, every `tsconfig.app.json`'s `extends`, and the `dist/apps/<name>` output shape untouched. Only the `../../libs/tcp-shared` path prefixes gained levels — [migration cost](#migration-cost)'s first two bullets shrank accordingly.
- **The `test/` tree moved with the apps, to `apps/backend/test/`.** Not anticipated here. It matters: all 30 spec files reach into app source with `../../../apps/tcp-<app>/src/…`, and moving both together leaves every one of those strings valid. Leaving `test/` at the root would have rewritten 30 files for no gain — it tests only the backend.
- **A root `tsconfig.base.json` was added.** [The root `package.json` section](#the-root-packagejson-shrinks-but-does-not-disappear) has `tsconfig.json` moving wholesale to `apps/backend/`, which would leave `libs/tcp-shared` extending an application's config. The shared `compilerOptions` live in `tsconfig.base.json` instead, and `apps/backend/tsconfig.json` extends it. It is deliberately not named `tsconfig.json`: a root one would be found by proximity, which is exactly how the browser workspace would silently inherit Node types and decorators.
- **`apps/backend/webpack.config.js` was needed, and is not optional.** Nest's default webpack config calls `nodeExternals()`, which looks for `node_modules` relative to the CWD. `nest build` now runs from `apps/backend`, where npm's hoisting leaves no such directory — so nothing was externalised and webpack tried to bundle the entire dependency tree, including optional peers (`@mikro-orm/core`, `@nestjs/mongoose`) it cannot resolve. The override points `additionalModuleDirs` at the root. It must **also** allowlist `@tcp/shared`: as a package it resolves through a `node_modules` symlink into `libs/`, which the runtime images do not copy, so externalising it emitted a bare `require('@tcp/shared')` and killed every container at startup. Nothing short of running an image catches that — the build, the typecheck and all five test tiers pass either way. It is the sharpest edge in this migration.
- **The enforcement is two layers here, not three, and the first is weaker than described.** [The `exports` section](#tcp-shared-becomes-a-package-and-its-exports-map-is-the-enforcement) says the frontend's `tsconfig.json` declaring no `@tcp/shared` alias keeps the bare specifier out. It does not: `@tcp/shared` is a real workspace package, so ordinary node resolution finds it through the `node_modules` symlink regardless. Omitting the alias removes the convenient route; the `no-restricted-imports` rule is what actually fails the edit. Vite is the third layer and arrives with 002.01. `apps/frontend/tcp-frontend/test/fixtures/server-import-must-fail.ts` is a committed fixture that must fail lint, asserted by `npm run test:import-boundary`.

Two consequences of the `./client` surface worth recording:

- **Model types are exported with `export type`, never as values.** `AuditEventType` (a const object) and `AgentStatus` (an enum) exist at runtime, but their modules import `typeorm`, so only their type side crosses the boundary. A web client needing either as a value must first extract it to an import-free module.
- **`crypto`'s `UUID` was replaced by `libs/tcp-shared/src/uuid.ts`.** Fourteen model files imported the type from `crypto`, which made the shared _type_ surface depend on `@types/node` and forced the browser workspace to declare Node types. The local alias is the same template literal type, so `randomUUID()` still assigns without a cast.

- **The aislop gate had to be re-based, not just re-pointed.** `ai-slop/hallucinated-import` checks imports against the nearest `package.json`. The root one no longer declares a single runtime dependency, so every `@nestjs/*`, `joi` and `express` import read as hallucinated — 85 findings, 83 of them false, dropping the score from 76 to 35 and turning `ci.failBelow: 74` from a gate into an obstacle. The rule is now `off` at the root, where it cannot work; `aislop ci apps/backend` resolves correctly and scores 83. TypeScript already fails on an unresolvable import, so the loss is small. It did surface two real undeclared dependencies: `webpack-node-externals` (now declared) and `express` (pre-existing, left alone).
- **Git hooks are copies, not symlinks.** `npm run hooks:install` copies `scripts/hooks/*` into `.git/hooks/`. Editing the tracked versions changes nothing until it is re-run — which matters most for the migration-drift guard, whose whole risk is silent failure.

**ADR bodies elsewhere in `docs/ADRs/` were not path-swept.** They are dated records, and most of their `apps/tcp-<app>/…` references describe where code was at the time. `docs/development.md` is the authority on the current layout.

## Amendment as implemented (002.01) <a id="amendment-as-implemented-00201"></a>

**Layer 3 does not exist by default — it had to be built.** [The `exports` section](#tcp-shared-becomes-a-package-and-its-exports-map-is-the-enforcement) says "Vite fails the build when it meets `typeorm` or `ioredis`", and [the 002.00 amendment](#amendments-as-implemented-00200) repeats it as arriving with 002.01. Tested directly with Vite 8 (rolldown), it is false: adding `import '@tcp/shared'` to a source file **builds successfully**. Vite externalises the Node built-ins with warnings and emits a bundle carrying express, body-parser, multer and busboy — 4.5 MB against the normal 250 kB. It then fails in the browser at runtime, with nothing pointing back at the import.

The layer is therefore an explicit `resolveId` plugin in `apps/frontend/tcp-frontend/vite.config.ts`, which throws on the bare specifier and on any deep import other than `@tcp/shared/client`. Making it explicit also covers the development server, which the assumed behaviour never would have.

All three layers are now exercised: the eslint rule fires (asserted by `npm run test:import-boundary`), the plugin fails the build with a legible message, and `src/shared-client.ts` imports a **value** from `@tcp/shared/client` as the positive control — the previous `import type` was erased before the bundler saw it and proved nothing about resolution through the `exports` map.

### How the migration-drift guard was verified

Firing is not enough to prove the path fix: a guard with a typo'd migration path
fires identically. Both halves were checked.

1. **It fires.** A scratch branch whose upstream was the migration branch (so the
   diff was one commit — the branch itself moves migration files, which would
   otherwise mask the test) added an `@Column` to `TcpCompany.model.ts` with no
   migration. `bash .git/hooks/pre-push` exited 1 naming that file.
2. **It recognises migrations at the new path.** The regex, extracted from the
   installed hook rather than retyped, matches a real
   `apps/backend/apps/tcp-server/src/migrations/*.ts` file and does not match the
   old `apps/tcp-server/…` location.

Re-run both after any change to the hook — and run `npm run hooks:install` first.
