/**
 * Negative control for the `@tcp/shared` import boundary. **This file is
 * meant to fail lint** — `npm run test:import-boundary` passes only when
 * eslint reports `no-restricted-imports` against it.
 *
 * Without a check like this the boundary is a comment: the rule could be
 * dropped from eslint.config.mjs and nothing would notice until a browser
 * bundle tried to load TypeORM.
 *
 * It is excluded from the frontend's tsconfig `include` and from the root
 * eslint `ignores`, so neither `npm run typecheck` nor `npm run lint:check`
 * trips over it; the boundary script re-enables it with `--no-ignore`.
 */
import '@tcp/shared';
