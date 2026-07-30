# ADR-029: SPA Hosting and Runtime Configuration

**Status:** Proposed (2026-07-30)

## Context

The web app compiles to a static SPA. That is a requirement, and it creates a
problem the rest of the stack does not have: **the bundle is built once and must
run in several environments**, but it needs environment-specific values — the
API base URL, the OIDC issuer URL, the OIDC client ID. Baking them in at build
time would mean one image per environment, which defeats the point of a static
build.

Four other decisions converge on this one:

- [ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) needs CORS — unless
  the SPA and the API share an origin.
- [ADR-025](ADR-025-browser-event-stream-consumption.md) needs HTTP/2, because
  five or more concurrent SSE connections is an ordinary working state and
  HTTP/1.1 caps a browser at six per origin.
- [ADR-024](ADR-024-browser-oidc-client-and-token-handling.md) needs redirect
  URIs derived from the app's actual origin, not hardcoded.
- The repository's port convention is `EXPOSE_PORT_<SERVICE>`, consumed as
  `${VAR:-default}` and threaded through `scripts/lib/derive-urls.sh` and
  `scripts/lib/check-ports.sh`.

## Options considered

|                         | **Same-origin reverse proxy**          | Entrypoint-generated `config.js`        | Build-time env baking |
| ----------------------- | -------------------------------------- | --------------------------------------- | --------------------- |
| API base URL            | Not needed — it is `/api`              | Injected at container start             | Baked per environment |
| CORS                    | **Never arises**                       | Required                                | Required              |
| HTTP/2                  | At the proxy, for API and assets alike | Needs separate configuration            | Not addressed         |
| OIDC issuer / client ID | Still needed at runtime                | Injected the same way                   | Baked                 |
| Works on a static CDN   | No                                     | Yes                                     | Yes                   |
| Moving parts            | One nginx config                       | One nginx config + an entrypoint script | None                  |

The two are not mutually exclusive: the proxy removes the API base URL from
runtime configuration but not the OIDC values, which the SPA needs before it can
talk to anything.

## Decision

**One nginx image that serves the built assets and reverse-proxies `/api` to
tcp-server, with a small entrypoint-generated `config.js` for the values the
proxy cannot remove.**

### The proxy is chosen because it collapses four problems into one

Same-origin is not primarily an ergonomic choice here. It means:

- **No CORS.** ADR-023's first item disappears rather than being configured, and
  there is no preflight on any request.
- **No API base URL in runtime config.** It is `/api`, always, everywhere.
- **HTTP/2 at one place**, satisfying ADR-025 for both the API and the assets.
- **One origin**, which keeps cookie-based auth available as a future option
  without re-architecting (ADR-024's deferred BFF path).

Each of those is individually minor. Together they remove more configuration
than the proxy adds, which is why it wins on the simplicity criterion the
originating prompt set — the simplest system, not the smallest single component.

### `config.js` carries only what remains

A tiny entrypoint script substitutes environment variables into a `config.js`
served alongside the bundle and loaded before it:

```js
window.__TCP_CONFIG__ = {
  oidcIssuerUrl: '…',
  oidcClientId: '…',
};
```

Two values, both OIDC. The API base URL is absent by construction. The script
runs at container start, so one image serves every environment.

`config.js` must be served with `Cache-Control: no-store` while the hashed
bundle assets are served immutable — a cached `config.js` pointing at the
previous environment's issuer is a confusing failure.

### HTTP/2 in development, not only in production

`vite dev` serves HTTP/1.1 by default. Under ADR-025's connection pattern that
caps development at six streams, and the failure mode is requests **hanging with
no error** — indistinguishable from a backend fault, and the kind of thing that
costs a day.

Two options for development, both acceptable: enable HTTP/2 on the Vite dev
server, or run the same nginx image in front of it. The second is more faithful
to production and also gives the dev environment the same-origin `/api` path, so
the app's own configuration does not differ between dev and deployment. Either
way, this must be verified early rather than assumed.

### Port and script wiring

`EXPOSE_PORT_WEB` follows the existing convention. Host ports 3000, 3001, 3002,
3010–3013, 5432, 8080, 9000 and 9001 are taken; **5173** (Vite's default) and
4173 are free. It is added to `docker-compose.yml`, to `derive_host_urls` in
`scripts/lib/derive-urls.sh`, and to `scripts/lib/check-ports.sh` — which
pre-flight-checks only API/DB/MinIO/Zitadel today, so a new service is not
covered unless it is added there.

Note that `.env.example`'s comment claiming other ports are derived
arithmetically from `EXPOSE_PORT_API` is stale — no code implements it. The web
port is an independent variable like the others.

### SPA routing

nginx falls back to `index.html` for any path that is not a file and not
`/api`, so React Router's deep links survive a page refresh. Without it, loading
`/company/acme` directly returns 404 — a classic and easily-missed SPA
deployment fault that only shows up on refresh, never in navigation.

## Consequences

- A seventh service in `docker-compose.yml`, with a build target in the root
  `Dockerfile`. Its final stage is the simplest of them all: static assets on
  `nginx:alpine`, no `node_modules`, no Node runtime
  ([ADR-022](ADR-022-monorepo-workspace-structure.md)).
- nginx configuration becomes a maintained artefact: proxy rules, HTTP/2, SPA
  fallback, and cache headers that differ per path. Small, and it is
  infrastructure that has to be right.
- tcp-server sits behind a proxy for browser traffic. It already runs behind
  Docker networking, but forwarded headers should be handled correctly if
  anything ever depends on client IP or scheme.
- `enableCors()` is **not** wired by default. ADR-023 keeps it documented as the
  fallback for a split-origin deployment; someone deploying the SPA to a CDN
  must enable it and set an origin allowlist.
- Deploying to a static CDN loses the proxy and therefore needs both CORS and an
  API base URL in `config.js`. The `config.js` mechanism already exists for the
  OIDC values, so this remains possible — it is a documented deployment shape,
  not an unsupported one.
- The dev environment needs HTTP/2 too, which is one more thing to get right
  before the first streaming surface is built.
- `EXPOSE_PORT_WEB` must be added to `check-ports.sh` or the pre-flight check
  silently ignores a port collision that then appears as a Docker bind error.

## Alternatives considered

- **`config.js` alone, no proxy** (CORS + a configured API base URL). Fewer
  moving parts in the container, more configuration everywhere else: CORS
  allowlists per environment, preflight on every request, an API base URL to get
  wrong, and HTTP/2 to arrange separately. Rejected on total simplicity, which is
  the criterion the prompt set.
- **Build-time environment baking.** Simplest possible runtime — and one image
  per environment, which contradicts "built once, hosted statically". Rejected.
- **Serving the SPA from tcp-server** (NestJS static assets). Automatically
  same-origin with no extra container. Rejected: it couples the frontend's
  release to the API's, puts static-asset serving in an application process, and
  gives up nginx's caching and compression for no gain.
- **A CDN with an edge proxy.** The right answer at scale and disproportionate
  here — the stack is a local-first Docker Compose deployment.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `002.04.00.prompt - backend api enablement for the web ui (draft).md`
- `004.01.00.prompt - oidc client (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `009.01.00.prompt - browser test suite for mvp journeys (draft).md`
