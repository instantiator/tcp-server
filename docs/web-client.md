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

The deployment serves the app. The `tcp-web` service is an nginx image holding
the built bundle, and it reverse-proxies `/api` to tcp-server so the browser
sees a single origin ([ADR-029](ADRs/ADR-029-spa-hosting-and-runtime-configuration.md)).

```bash
./scripts/start-deployment.sh --project tcp-dev --env-file .env.dev
# → https://localhost:5173
```

**https, not http, and that is not optional.** The live views open five or more
simultaneous event streams, HTTP/1.1 caps a browser at six connections per
origin, and the seventh request then hangs with no error — a symptom
indistinguishable from a broken backend
([ADR-025](ADRs/ADR-025-browser-event-stream-consumption.md)). HTTP/2 removes
the ceiling by carrying every stream over one connection, and **no browser
negotiates HTTP/2 without TLS** — there is no cleartext h2c in Chrome, Firefox
or Safari. So the certificate is not production hardening; it is what makes
HTTP/2 exist at all, including on a laptop.

The container generates a self-signed certificate on first start, so nothing
has to be set up before the stack will run. Your browser will warn once per
machine. [Use mkcert](#a-trusted-certificate-with-mkcert) to stop it.

### Two ports

| Variable              | Default | What listens                                                     |
| --------------------- | ------- | ---------------------------------------------------------------- |
| `EXPOSE_PORT_WEB`     | `5173`  | nginx — HTTPS and HTTP/2. The address people and tests use.      |
| `EXPOSE_PORT_WEB_DEV` | `4173`  | The Vite development server — plain HTTP, reached only by nginx. |

`.env.testing` sets `EXPOSE_PORT_WEB=5174`, so a testing stack can run
alongside a dev one — the same reason its `EXPOSE_PORT_API` is `3001`.

### The development loop

Vite's development server has no HTTP/2 implementation, so working directly
against it would mean developing under the exact six-connection ceiling the
deployment doesn't have. Instead, nginx stays in front and proxies to it:

```bash
npm run dev --workspace apps/frontend/tcp-frontend                  # Vite on 4173
./scripts/start-deployment.sh --project tcp-dev --env-file .env.dev --dev-web
# → https://localhost:5173, now served by Vite through nginx
```

Hot module replacement still works. nginx doesn't implement WebSockets over
HTTP/2 (RFC 8441), so the browser opens a separate HTTP/1.1 connection for the
HMR socket and passes it through `proxy_set_header Upgrade` — page loads and
API calls stay on HTTP/2.

Loading `http://localhost:4173` directly also works, but there is no `/config.js`
there and no `/api`, so the app throws on startup with an error saying exactly
that (`src/runtime-config.ts`).

The other workspace commands are unchanged:

```bash
npm run build --workspace apps/frontend/tcp-frontend    # static bundle into dist/
npm run preview --workspace apps/frontend/tcp-frontend  # serve that bundle, HTTP/1.1
```

The root commands cover this workspace too: `npm run build`, `npm run lint`,
`npm run lint:check`, `npm run typecheck` and `npm test` all delegate with
`npm run … --workspaces --if-present`, so CI needs no frontend-specific job.

### A trusted certificate, with mkcert

Optional. It replaces the browser's warning with a padlock, and lets `curl`
work without `-k`. It takes about two minutes, once per machine.

[mkcert](https://github.com/FiloSottile/mkcert) generates certificates signed
by a local certificate authority that it installs into your system and browser
trust stores. Nothing it produces is trusted anywhere else, which is the point.

```bash
# 1. Install it.
brew install mkcert nss          # macOS; nss is for Firefox
sudo apt install mkcert          # Debian/Ubuntu

# 2. Install the local CA into your system and browser trust stores.
mkcert -install

# 3. Generate the certificate the container expects.
mkdir -p docker/nginx/certs
mkcert -cert-file docker/nginx/certs/tls.crt \
       -key-file  docker/nginx/certs/tls.key \
       localhost 127.0.0.1 ::1

# 4. Hand it to the container. Add this to docker-compose.dev-web.yml, or
#    to a compose override of your own:
#
#      services:
#        tcp-web:
#          volumes:
#            - ./docker/nginx/certs:/etc/nginx/certs:ro
#
# 5. Restart the stack.
```

A mounted certificate always wins: the entrypoint only generates one when
`/etc/nginx/certs/tls.crt` is missing or empty. `docker/nginx/certs/` is
gitignored — a mkcert certificate is trusted only by the machine whose CA
signed it, and its private key should not travel.

For a real deployment, mount a real certificate the same way.

### Runtime configuration

The bundle is built once and runs in several environments, so two values reach
it at startup rather than at build time — the identity provider's address and
the client ID. `docker/nginx/10-tcp-init.sh` writes them into `/config.js` when
the container starts, and `index.html` loads it ahead of the bundle:

```js
window.__TCP_CONFIG__ = {
  oidcIssuerUrl: '…',
  oidcClientId: '…',
};
```

Read it through `getRuntimeConfig()` in `src/runtime-config.ts`, never off the
global directly. There is no API address here, by construction: it is always
`/api`, on this same origin.

`config.js` is served `Cache-Control: no-store`, while everything under
`/assets/` is `immutable`. That asymmetry is deliberate — Vite content-hashes
assets, so a cached one can never be stale, whereas a cached `config.js` from
another environment points the app at the wrong identity provider and fails at
sign-in with nothing to suggest why.

The container refuses to start if either value is empty, rather than serving a
blank issuer that fails several steps later.

#### CORS is not configured, deliberately

`enableCors()` is **not** called in [main.ts](../apps/backend/apps/tcp-server/src/main.ts),
and will not be. `tcp-web` reverse-proxies `/api` to tcp-server on the same
origin, so a browser never makes a cross-origin API call — there is nothing
for an allowlist to permit.

The one deployment shape that loses the proxy is serving the built bundle from
a static CDN. That shape needs two things this repo does not have: an API base
URL in `config.js` (there is deliberately none — see above), and CORS on the
server. If it is ever built, the server half is:

```ts
// main.ts, before app.listen
app.enableCors({ origin: [process.env.TCP_WEB_URL!], credentials: true });
```

with the allowlist derived from `TCP_WEB_URL`, the same environment value that
already carries the web address. Do not add it now: an allowlist nobody
exercises is an allowlist nobody maintains.

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
  Three TypeScript projects, each in the directory it governs. Editors resolve a
  file by walking up to the nearest file _named_ `tsconfig.json` and ignore every
  other name, so a project under any other name gets typechecked on the command
  line while the IDE falls back to a default with no `types` at all:

- `src/tsconfig.json` — the browser bundle. `"types": []`, so Node types cannot
  leak in.
- `tsconfig.json` — the root-level tooling configs, `vite.config.ts` and
  `playwright.config.ts`, which do run in Node.
- `test/browser/tsconfig.json` — the Playwright specs, also Node.

> If an editor reports `process` as undefined in one of these and offers to add
> `"node"` to the browser project's `types`, don't: it dissolves the
> server/browser boundary ADR-022 exists to hold. The file belongs to one of the
> Node projects instead.

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
