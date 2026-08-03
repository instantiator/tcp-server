# Web client

The browser application, in the `apps/frontend/tcp-frontend` workspace. React
and Vite, routed by React Router, with TanStack Query as the only server-state
cache and React Aria Components for behaviour
([ADR-021](ADRs/ADR-021-web-ui-framework-and-architecture.md),
[ADR-026](ADRs/ADR-026-web-ui-accessibility-and-component-library.md)).

Nothing user-facing ships yet: the application renders a placeholder route.
What it does have is the set of seams every later prompt depends on, because
retrofitting them once components exist is disproportionately expensive.

## Running it

```bash
npm run dev --workspace apps/frontend/tcp-frontend      # development server
npm run build --workspace apps/frontend/tcp-frontend    # static bundle into dist/
npm run preview --workspace apps/frontend/tcp-frontend  # serve that bundle
```

The development server's port comes from `EXPOSE_PORT_WEB` (default `5173`),
read from the repo-root env files by `vite.config.ts` — the same convention
every other service follows. `strictPort` is on, so a collision fails rather
than silently moving. Serving the built bundle behind nginx, proxying `/api`,
and the SPA fallback for deep links are 002.03.

The root commands cover this workspace too: `npm run build`, `npm run lint`,
`npm run lint:check`, `npm run typecheck` and `npm test` all delegate with
`npm run … --workspaces --if-present`, so CI needs no frontend-specific job.

## Strings: one lookup, no literals in JSX

Every user-facing string resolves through `src/strings.ts`:

```tsx
import { t } from './strings';

<h1>{t('app.title')}</h1>; // never <h1>TCP</h1>
```

Keys are typed as `keyof typeof strings`, so a typo is a compile error. There
is no i18n library and there are no locale files yet — the seam exists so the
phase 03 translation work replaces one module instead of rewriting every
component. **Call `t(…)`; never import `strings` directly**, or the call sites
stop being replaceable.

## Theme: tokens, never literal values

Two axes live on `<html>`: `data-theme` (`default` | `high-contrast`) and
`data-mode` (`light` | `dark`). Every colour, spacing and border value resolves
through a `--tcp-*` custom property.

| File                                  | Holds                                                        |
| ------------------------------------- | ------------------------------------------------------------ |
| `src/styles/base.css`                 | Non-colour tokens, the reset, the focus ring, reduced motion |
| `src/styles/themes/default.css`       | Colour tokens, AA contrast (4.5:1)                           |
| `src/styles/themes/high-contrast.css` | Colour tokens, AAA contrast (7:1)                            |

Both theme files must declare the **same token names** — one declared in only
one of them is undefined under the other theme, which renders as an unstyled
element rather than an error. Component stylesheets added later carry
meaningful class names with **empty rule bodies**, to be filled per theme; a
literal colour in a component stylesheet is invisible to linting and breaks
theming silently, so it is a review matter.

`prefers-reduced-motion` is honoured in `base.css` from the start.

### How the choice is made and kept

`src/theme/storage.ts` owns the contract: one `localStorage` key
(`tcp.theme`) holding `{ theme, mode }`. On a first visit the choice is seeded
from `prefers-color-scheme` and `prefers-contrast` and then persisted — the
system settings set the starting point, they never override the user.
`ThemeProvider` holds it as React state and `useTheme()` reads it.

**The inline script in `index.html` deliberately duplicates that read.** It has
to run before the bundle to avoid a flash of the wrong theme, so it cannot
import the module. Change one, change the other; the storage key and the two
attribute names are the shared contract.

## The `@tcp/shared` boundary

The web client may import **only** `@tcp/shared/client`
([ADR-022](ADRs/ADR-022-monorepo-workspace-structure.md)). Three layers enforce
it, and all three are exercised:

1. `tsconfig.json` declares an alias for `@tcp/shared/client` only.
2. `no-restricted-imports` in `apps/frontend/tcp-frontend/eslint.config.mjs`
   fails the edit with a message naming the replacement.
   `test/fixtures/server-import-must-fail.ts` is a committed fixture that must
   fail lint; `npm run test:import-boundary` asserts it does.
3. A `resolveId` plugin in `vite.config.ts` throws on the bare specifier, in
   both the build and the development server.

Layer 3 is a plugin rather than the bundler's own behaviour on purpose. Vite
does **not** fail on its own: it externalises the Node built-ins with warnings
and builds successfully, turning a 250 kB bundle into a 4.5 MB one carrying
express, multer and busboy — which then fails at runtime, in a browser, with
no clue where it came from.

`src/shared-client.ts` is the positive control and imports a **value**, not
just a type: a type-only import is erased before the bundler sees it and would
prove nothing. Keep a value import reachable from the entry point.

## Tooling

The workspace has its own eslint and TypeScript configuration — the root ones
target Node, with CommonJS and decorators. Prettier is shared with the root.

- `eslint.config.mjs` — browser globals, ES modules, typed rules, and
  `eslint-plugin-jsx-a11y` **as errors** (ADR-026).
- `tsconfig.json` — the browser project. `"types": []`, so Node types cannot
  leak in.
- `tsconfig.node.json` — `vite.config.ts` only, which does run in Node.

> `eslint-plugin-jsx-a11y` declares an `eslint@^9` peer while this repo is on
> eslint 10. Without intervention npm installs a second, nested eslint 9,
> which then crashes against the repo's `brace-expansion` override — and a
> clean `npm ci` fails outright. The root `overrides` entry pinning that peer
> is what prevents it. Don't remove it until the plugin widens its range.

## Tests

Vitest and Testing Library, colocated as `src/**/*.test.{ts,tsx}`. The test
tier proper — including Playwright and the axe assertions — is 002.02; what is
here proves the setup works end to end and covers the two seams.

```bash
npm test --workspace apps/frontend/tcp-frontend
```

That runs Vitest and then `test:import-boundary`. jsdom resolves
stylesheet-declared custom properties, so the theme test asserts on the
computed `--tcp-*` values rather than on the attributes alone.
