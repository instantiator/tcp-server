# Web client

The browser application, in the `apps/frontend/tcp-frontend` workspace. React
and Vite, routed by React Router, with TanStack Query as the only server-state
cache and React Aria Components for behaviour
([ADR-021](ADRs/ADR-021-web-ui-framework-and-architecture.md),
[ADR-026](ADRs/ADR-026-web-ui-accessibility-and-component-library.md)).

One journey works end to end — [signing in](#signing-in). Everything behind it
is still a placeholder route, and what the application mostly has so far is the
set of seams every later prompt depends on, because retrofitting them once
components exist is disproportionately expensive.

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
./scripts/start-dev.sh --dev-web
# → https://localhost:5173, now served by Vite through nginx
```

`--dev-web` starts the Vite server on the host, waits for it to answer, and
then brings the stack up pointing at it — in that order, because nginx proxies
to Vite and the deployment's own health check on `tcp-web` cannot pass while
the upstream is refusing connections. `./scripts/stop-dev.sh` stops both.

The underlying two-command form still works, and is what to reach for when the
dev server is already running or needs different arguments:

```bash
npm run dev --workspace apps/frontend/tcp-frontend                  # Vite on 4173
./scripts/start-deployment.sh --project tcp-dev --env-file .env.dev --dev-web
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

The bundle is built once and runs in several environments, so three values
reach it at startup rather than at build time — the identity provider's
address, the client ID, and whether to load the user's profile from the
userinfo endpoint. `docker/nginx/10-tcp-init.sh` writes them into `/config.js`
when the container starts, and `index.html` loads it ahead of the bundle:

```js
window.__TCP_CONFIG__ = {
  oidcIssuerUrl: '…',
  oidcClientId: '…',
  oidcLoadUserInfo: false,
};
```

`oidcClientId` carries the public PKCE client `start-deployment.sh` registers
for the browser ([ADR-024](ADRs/ADR-024-browser-oidc-client-and-token-handling.md))
— not tcp-server's own confidential client, which has no business being
readable from a browser. `oidcLoadUserInfo` is emitted as an **unquoted**
JavaScript boolean, not a quoted string: `config.js` is code, and the string
`'false'` is truthy, so a quoted literal would satisfy `RuntimeConfig`'s type
while silently inverting the default. Unlike the other two values, its absence
doesn't stop the container — a missing boolean has a correct default (`false`)
where a missing issuer or client ID does not.

Read it through `getRuntimeConfig()` in `src/runtime-config.ts`, never off the
global directly. There is no API address here, by construction: it is always
`/api`, on this same origin.

`config.js` is served `Cache-Control: no-store`, while everything under
`/assets/` is `immutable`. That asymmetry is deliberate — Vite content-hashes
assets, so a cached one can never be stale, whereas a cached `config.js` from
another environment points the app at the wrong identity provider and fails at
sign-in with nothing to suggest why.

The container refuses to start if `oidcIssuerUrl` or `oidcClientId` is empty,
rather than serving a blank issuer that fails several steps later.

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

## Routing

React Router's route table, in `src/App.tsx`:

| Path                  | Page               | Access    | Built by                           |
| --------------------- | ------------------ | --------- | ---------------------------------- |
| `/`                   | Landing page       | Public    | 003.01                             |
| `/callback`           | Sign-in return     | Public    | 004.02                             |
| `/companies`          | Companies overview | Protected | placeholder here, real page 006.01 |
| `/company/:companyId` | Company view       | Protected | placeholder here, real page 006.01 |
| `*`                   | Not found          | Public    | 003.02                             |

Protected routes sit behind `RequireSession`, which redirects to `/` when
there is no session, carrying the attempted path in the location state.

`/callback` is public and has to be. It is where the identity provider returns a
user who does not have a session yet — behind the guard it would redirect to `/`
every time, which is a sign-in that bounces back to the sign-in control.

nginx returns the app document with a 200 for any unknown path
([ADR-029](ADRs/ADR-029-spa-hosting-and-runtime-configuration.md)) and always
will — a static server cannot know which paths the router knows. The
catch-all route is what makes an unknown address render a page rather than a
blank screen; the status code is not a defect.

The landing page and `/callback` render outside the shell and own their own
`main`. Every other page's `main` comes from `AppShell`. There must never be two
on one page.

## Signing in

Four hops, and nothing in between them is a decision this application makes:

1. **The control.** `startSignIn(state)` in `src/auth/sign-in.ts` calls
   `signinRedirect()` on the one `UserManager`
   ([ADR-024](ADRs/ADR-024-browser-oidc-client-and-token-handling.md)). `state`
   is whatever `RequireSession` put in the location state — `{ from }`, passed
   through untouched. `handleUnauthorized()` builds the same shape when the API
   rejects a token, so both entry points arrive at the same validation.
2. **The provider.** A full-page redirect. The client holds no refresh token, so
   this is both "sign in" and "renew": against a live provider session the user
   comes back in a few hundred milliseconds without seeing a form.
3. **`/callback`.** `react-oidc-context`'s `AuthProvider` performs the code
   exchange itself, on mount, when the address carries authorization parameters.
   **The page must not also call `signinRedirectCallback()`** — that would
   exchange the same single-use code twice, and the second attempt fails with
   "No matching state found in storage", reporting an error for a sign-in that
   worked. The page reads `useAuth()` and renders one of three things.
4. **The destination.** `safeRedirectTarget()` in `src/auth/redirect-target.ts`
   turns the returned `state` into a path, or into `/companies` if it cannot.

### The open-redirect gate

`state.from` is attacker-influenced twice over: it is read out of the address
bar, and it then makes a round trip through the provider. `safeRedirectTarget`
is the only code that trusts it, and it allows only two things:

- a URL whose origin, once parsed by `URL`, is this application's own — which is
  what rejects `//evil.example`, `/\evil.example` and `javascript:` alike; and
- a pathname matching one of the routes listed in `RETURNABLE_ROUTES`, which is
  exactly the set behind `RequireSession`.

`/` and `/callback` are deliberately not in that set — returning a
freshly signed-in user to either is the redirect loop — and neither is the
catch-all, which matches every address and would make the list decorative. The
query string travels with the path, because `handleUnauthorized()` saves
`pathname + search` and dropping half of it loses the view the user was on.

**Adding a protected route means adding it to `RETURNABLE_ROUTES`.** The list is
maintained by hand; a route missing from it still works, but a user sent there
before signing in quietly arrives at `/companies` instead.

### What a failure looks like

Nothing on `/callback` ever redirects to the provider on its own. Every route
back out is a control someone pressed — which is what makes the loop impossible
rather than unlikely.

| What happened                               | What the user sees                                       |
| ------------------------------------------- | -------------------------------------------------------- |
| Cancelled at the provider (`access_denied`) | "Sign-in was cancelled", with "Try again" and a way home |
| The provider returned any other error       | "Sign-in could not be completed"                         |
| The callback was replayed, or arrived twice | The same message — the user's next action is identical   |
| `/callback` opened directly                 | "This page is part of signing in…", with no retry        |
| The redirect never started at all           | The landing page says so, beside the sign-in control     |

## Staying signed in

A page reload loses the in-memory tokens, so `RequireSession` recovers the same
way [signing in](#signing-in) does: it calls `handleUnauthorized()`, which makes
one deduplicated `signinRedirect()`. Against an active provider session that's a
few hundred milliseconds and no visible form; against an expired one, the
provider's login page appears, which is correct rather than a bug. While
recovery is in flight the guard renders `LoadingState`; if the redirect itself
never starts, it renders `ErrorState` with a **Try again** control rather than
leaving the visitor stuck on a blank guard.

`getUserManager()` sets `accessTokenExpiringNotificationTimeInSeconds: 30` and
subscribes once to `accessTokenExpired`, removing the user when it fires.
`automaticSilentRenew` is off, so nothing else was watching that event, and
`react-oidc-context` only recomputes `isAuthenticated` when something
dispatches — without this the account menu kept rendering against a token that
had already gone. Thirty seconds ahead of that, `SessionExpiryWarning`
(rendered in `AppShell`, between the header and `main`) announces the expiry
assertively through the one announcer
([ADR-027](ADRs/ADR-027-screen-reader-strategy.md#one-announcer-not-scattered-live-regions))
and shows a **Stay signed in** control that makes the same redirect on demand —
that control is what makes the timed session meet WCAG 2.2.1 "Timing
Adjustable". Nothing here self-dismisses on a timer
([ADR-026](ADRs/ADR-026-web-ui-accessibility-and-component-library.md), WCAG
2.2.3); the warning leaves only when the session renews or the user is removed.

## Signing out

`startSignOut()` in `src/auth/sign-out.ts`, called from the account menu, ends
the session at the provider with `signoutRedirect()` and returns the user to
the landing page (`${origin}/`, which is unguarded). `signoutRedirect()`
removes the local user itself, before it builds the provider request — so by
the time a provider with no `end_session_endpoint` throws (RP-initiated logout
is optional in OIDC; Zitadel publishes one), the local side is already clean
and only the navigation is missing. The fallback clears the user again and
navigates to `/` itself, so sign-out never throws out of the menu item.

## `?devSession=`: skipping the provider

`?devSession=<id>` on any URL supplies a stand-in signed-in user, so the
header, the account menu and the protected routes can be exercised without going
through the identity provider — for example
`http://localhost:4173/companies?devSession=alice`.

It is the **fallback**, not an override: `AuthSession` prefers a real OIDC user
whenever there is one, so signing in for real always wins.

A `Session` is still `{ userId }` and nothing else — 004.03 added reload
recovery, expiry and sign-out without putting a token in it. That matters here:
the danger this parameter would pose is minting something that stands in for a
credential, and it cannot, because there is no credential in a `Session` to
mint. If that ever changes, re-read `src/dev/dev-session.ts` and decide
deliberately what it may set.

It is read once at startup (`src/main.tsx`), so it survives in-app navigation
that drops the query string, but it does **not** survive a manual reload of a
URL without the parameter. A `console.warn` names it on every page where it is
active.

**It only works where the app is served in development mode**, which is the
part that catches people out:

| How you started it                                   | URL                      | Works? |
| ---------------------------------------------------- | ------------------------ | ------ |
| `./scripts/start-dev.sh --dev-web`                   | `https://localhost:5173` | Yes    |
| `npm run dev --workspace apps/frontend/tcp-frontend` | `http://localhost:4173`  | **No** |
| `./scripts/start-dev.sh`                             | `https://localhost:5173` | **No** |

Without `--dev-web`, `tcp-web` serves the **built** bundle out of
`/usr/share/nginx/html` — a production `vite build`, which is exactly where the
parameter has been compiled away. A protected route leaves for the identity
provider instead — since 004.03 that is what a guarded route with no session
does — with nothing in the console to explain why, because the code that would
have logged it is not there either. That is the guarantee below working, not a
fault to debug. `start-dev.sh` says which of the two it gave you as its last
line, for that reason.

`--dev-web` is now the **only** one to use. Since 004.02 mounted `AuthProvider`
at the root, the OIDC client is constructed on load, and `getRuntimeConfig()`
throws when `/config.js` is absent — which it is under a bare `vite dev`, because
nothing generates it there. The message names the fix, but it arrives as a blank
page rather than as text, so the symptom to recognise is a white screen on 4173.

**Why it is safe:** it is compiled out of a production build, not disabled in
one. `import.meta.env.DEV` is replaced with a literal at build time, so the
whole branch is unreachable code the minifier drops. Two browser-tier tests in
`test/browser/app-shell.spec.ts` assert this against a real deployment — one
that the route guard still redirects, one that the string `devSession` does
not appear in the served bundle.

**What it does not do:** a session today is a user id and nothing else. It
carries no token, so tcp-server refuses every API call it leads to with a 401,
exactly as it would for a signed-out visitor. It is a way to see the shell,
not a way to reach data.

**The constraint on future work:** when 004.03 makes the session hold a
bearer token, a session built from a query string must not be able to mint
one. Today it sets `AuthSession`'s `fallback` and nothing else, which is why a
real user always displaces it — that ordering is the thing to preserve. [prompts/phase 02 - web ui/009.04.00.prompt - production build flag and development feature flags (draft).md](<prompts/phase 02 - web ui/009.04.00.prompt - production build flag and development feature flags (draft).md>)
owns the general production-build-flag rule this capability is the first case
of.

## Announcements: one announcer, coalesced and throttled

Everything a screen reader is told, it is told from `src/announce/announcer.ts`
([ADR-027](ADRs/ADR-027-screen-reader-strategy.md)).

```ts
import { announce } from './announce/announcer';

announce({ channel: 'tasks', change: 'announce.tasksAdded' });
```

**No component renders a live region.** The announcer owns the only two — a
polite one and an assertive one, built by
[`@react-aria/live-announcer`](https://www.npmjs.com/package/@react-aria/live-announcer)
and kept in `document.body`, outside the React root. That is not a style
preference. A region mounted at the same moment as its content announces all of
it or none of it, and two regions updating together interleave into output that
reads as neither message. Both failures look completely correct in a component
test that only asserts on markup.

Every announcement names a **channel** — one surface, one channel. Changes on a
channel accumulate for `ANNOUNCE_THROTTLE_MS` and are then spoken as one
phrase, so a task fanning out to fifty assignments becomes "Tasks: 50 added"
rather than fifty interruptions. Repeats are **counted, not discarded**: two
identical calls mean two things happened.

That last point is the one that bites. Because the announcer counts, guarding
against `StrictMode`'s double-invoked effects is the **caller's** job:

```ts
// Guard on the value that changed…
const announced = useRef<string | null>(null);
useEffect(() => {
  if (announced.current === message) return;
  announced.current = message;
  announce({
    channel,
    change: 'state.error.announcement',
    params: { message },
  });
}, [channel, message]);

// …never on whether the effect has run. StrictMode spends this on mount.
const hasRun = useRef(false);
```

| Surface       | Politeness  | When                                                        |
| ------------- | ----------- | ----------------------------------------------------------- |
| Route change  | `polite`    | Immediately, after focus moves to the main heading          |
| Live lists    | `polite`    | Coalesced, once per `ANNOUNCE_THROTTLE_MS`                  |
| Loading       | `polite`    | On completion only, and only over `ANNOUNCE_LOADING_MIN_MS` |
| Errors        | `assertive` | Immediately                                                 |
| Notifications | either      | Once, on appearance; `assertive` when it carries a failure  |
| Empty states  | —           | Never — they are reached by browsing                        |

`ANNOUNCE_THROTTLE_MS` (10s) and `ANNOUNCE_LOADING_MIN_MS` (1s) are provisional
guesses that 009.02's manual screen reader pass tunes.

The gate is `src/announce/announcer.test.tsx`, which asserts on
`spokenPhraseLog()` from `@guidepup/virtual-screen-reader` — the ordered
sequence of everything a screen reader would say. Component tests for anything
that announces belong there too, not in an assertion on the DOM.

`test/browser/app-shell.spec.ts` covers the one half jsdom cannot: react-aria
delays its _first_ announcement by 100ms in a real browser so the regions have
attached, and skips that delay entirely under test. The browser tier proves
both regions exist empty on load, and that a real navigation lands the page
title in the polite one.

## Shared states

Four components, in `src/components/`, for the situations every data-driven
view meets. None of them mounts a live region.

| Component      | Role                                  | Announces                              |
| -------------- | ------------------------------------- | -------------------------------------- |
| `LoadingState` | Indeterminate `progressbar`           | Nothing — see `useLoadingAnnouncement` |
| `ErrorState`   | `group`, in place beside the failure  | The message, `assertive`               |
| `EmptyState`   | A heading and a body                  | Nothing                                |
| `Notification` | `group`, with a required durable link | Once, on appearance                    |

`ErrorState` is deliberately **not** `role="alert"`: that role _is_ a live
region, and three failing lists would mount three of them. `Notification`'s
`durableHref` is required for the same kind of reason — WCAG 2.2.3, adopted by
[ADR-026](ADRs/ADR-026-web-ui-accessibility-and-component-library.md), forbids a
notice that vanishes being the only record of an event, and a required prop
enforces that at compile time rather than at review time. Nothing here
self-dismisses.

Nothing consumes these yet: 006.01 and 007.01 are the first views to.

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

`t` takes an optional second argument filling `{placeholder}` slots:

```ts
t('announce.tasksAdded', { count: 2 }); // 'Tasks: 2 added'
```

That is the whole of it — no pluralisation, no number or date formatting, no
nesting. An unmatched placeholder is left in the output rather than blanked, so
a missing value is visible instead of reading as though it worked. Because
there are no plural rules, announcement wordings are phrased count-agnostically
(`'Tasks: {count} added'`, never `'{count} tasks added'`).

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

## Event client

`src/events/` reads the company, task and agent Server-Sent Events streams
([ADR-025](ADRs/ADR-025-browser-event-stream-consumption.md)):

| File                | Holds                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| `connect.ts`        | The reconnecting reader — one connection, kept alive until closed           |
| `subscriptions.ts`  | `subscribe(url, onEvent, onError)`, `streamUrls`, and the `MAX_STREAMS` cap |
| `cache.ts`          | `applyEvent(queryClient, event)` — folds a `WireEvent` into the query cache |
| `useEventStream.ts` | The React hook components call                                              |

`subscribe` shares one connection per URL across every subscriber, opened on
the first and closed after the last, so several components watching the same
stream don't each open their own. `MAX_STREAMS = 12` is a hard cap — twice
HTTP/1.1's six-per-origin ceiling, which HTTP/2 removes anyway — and exceeding
it **throws visibly** rather than queuing connections silently.

**Reconnection.** `connect.ts` retries a dropped stream with exponential
backoff and full jitter (1s base, 30s cap), and pauses entirely while
`navigator.onLine` is false or the tab is hidden, resuming immediately on
either. A fresh token is fetched on every attempt, including reconnects, so a
token that expired mid-connection doesn't get retried forever. A `401`
routes through the shared `handleUnauthorized()` policy; a `403` (or any other
`4xx`) surfaces as an `ApiError` and is never retried — that is a permanent
refusal, not a blip.

**Reconnection correctness depends on the server continuing to prime.** The
client keeps no bookkeeping across a drop — no last-seen id, no replay buffer.
Recovery instead relies on the server: the company and task streams prime with
current state on every subscribe, and the agent stream synthesises a terminal
event for a late subscriber that missed it. A reconnected stream re-renders
correctly only because of that priming, not because of anything the client
remembers. That coupling is load-bearing, not incidental — ADR-025 records it,
and changing how any of the three streams prime is a client-behaviour change
even though no client file moves.

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
