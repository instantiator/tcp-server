# ADR-029: SPA Hosting and Runtime Configuration

**Status:** Proposed (2026-07-30)

## Context

The web app compiles to a static SPA[^spa]. That's a requirement, and it creates a problem the rest of the stack doesn't have.

**The bundle is built once, but has to run in several environments** — and it needs environment-specific values: the API address, the identity provider's address, and the client ID. Building those in would mean one image per environment, which defeats the point of a static build.

[^spa]: Single-page application — the whole app is one HTML page plus JavaScript, which then handles navigation itself rather than requesting a new page from the server.

## What needs deciding

How environment-specific configuration reaches a bundle that was built without it.

Three other decisions converge on this one:

- [ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md) needs CORS — **unless** the app and the API share an address.
- [ADR-025](ADR-025-browser-event-stream-consumption.md) needs HTTP/2, because five or more simultaneous event streams is normal and HTTP/1.1 caps a browser at six per address.
- [ADR-024](ADR-024-browser-oidc-client-and-token-handling.md) needs sign-in redirect URLs derived from the app's actual address, not hardcoded.

## Options considered

|                              | **Same-origin reverse proxy**          | Generated `config.js`                   | Build-time baking     |
| ---------------------------- | -------------------------------------- | --------------------------------------- | --------------------- |
| API address                  | Not needed — it's `/api`               | Injected when the container starts      | Baked per environment |
| CORS                         | **Never arises**                       | Required                                | Required              |
| HTTP/2                       | At the proxy, for API and assets alike | Needs separate configuration            | Not addressed         |
| Identity provider / clientID | Still needed at runtime                | Injected the same way                   | Baked                 |
| Works on a static CDN        | No                                     | Yes                                     | Yes                   |
| Moving parts                 | One nginx config                       | One nginx config + an entrypoint script | None                  |

The first two aren't mutually exclusive: the proxy removes the API address from runtime configuration, but not the identity provider values, which the app needs before it can talk to anything.

## Decision

**One nginx image that serves the built assets and reverse-proxies[^proxy] `/api` to tcp-server, plus a small generated `config.js` for the values the proxy can't remove.**

The proxy is chosen because it [collapses four problems into one](#why-the-proxy-wins):

- **No CORS** — ADR-023's first item disappears rather than being configured
- **No API address in runtime config** — it's `/api`, always, everywhere
- **HTTP/2 in one place**, satisfying ADR-025 for both the API and the assets
- **One address**, which keeps cookie-based auth available as a future option

That leaves [two values in `config.js`](#configjs-carries-only-what-remains), both about identity.

Three further points: [HTTP/2 is needed in development too](#http2-in-development-not-only-in-production), [`EXPOSE_PORT_WEB` has to be wired into three places](#port-and-script-wiring), and [nginx needs an SPA fallback](#spa-routing) or refreshing a deep link returns 404.

[^proxy]: A reverse proxy sits in front of one or more servers and forwards requests to them. Here it makes the app and the API look like one address to the browser.

## Consequences

- A seventh service in `docker-compose.yml`, with a build target in the root `Dockerfile`. Its final stage is the simplest of them all: static assets on `nginx:alpine`, no `node_modules`, no Node runtime ([ADR-022](ADR-022-monorepo-workspace-structure.md)).
- nginx configuration becomes a maintained artefact — proxy rules, HTTP/2, SPA fallback, and cache headers that differ per path. Small, and infrastructure that has to be right.
- tcp-server sits behind a proxy for browser traffic. It already runs behind Docker networking, but forwarded headers should be handled properly if anything ever depends on the client's address or scheme.
- `enableCors()` is **not** wired by default. ADR-023 keeps it documented as the fallback; anyone deploying to a CDN has to enable it and set an allowlist.
- Deploying to a static CDN loses the proxy, and therefore needs both CORS and an API address in `config.js`. The mechanism already exists for the identity values, so this stays a documented deployment shape rather than an unsupported one.
- The development environment needs HTTP/2 too — one more thing to get right before the first streaming surface is built.
- `EXPOSE_PORT_WEB` must be added to `check-ports.sh`, or the pre-flight check silently ignores a port collision that then appears as a Docker bind error.

## Alternatives considered

- **`config.js` alone, no proxy** — CORS plus a configured API address. Fewer moving parts in the container, and more configuration everywhere else: allowlists per environment, a preflight request on every call, an API address to get wrong, and HTTP/2 to arrange separately. Rejected on total simplicity, which is the criterion the prompt set.
- **Build-time baking.** The simplest possible runtime, and one image per environment — which contradicts "built once, hosted statically". Rejected.
- **Serving the app from tcp-server** as static assets. Automatically same-address, with no extra container. Rejected: it ties the frontend's release to the API's, puts asset serving inside an application process, and gives up nginx's caching and compression for no gain.
- **A CDN with an edge proxy.** The right answer at scale, and disproportionate here — the stack is a local-first Docker Compose deployment.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `002.04.00.prompt - backend api enablement for the web ui (draft).md`
- `004.01.00.prompt - oidc client (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `009.01.00.prompt - browser test suite for mvp journeys (draft).md`

## Detail

### Why the proxy wins

Same-origin isn't primarily an ergonomic choice. Each of the four gains is individually minor; together they remove more configuration than the proxy adds.

That's why it wins on the simplicity criterion the originating prompt set — **the simplest system, not the smallest single component.**

### `config.js` carries only what remains

A tiny entrypoint script substitutes environment variables into a `config.js`, served alongside the bundle and loaded before it:

```js
window.__TCP_CONFIG__ = {
  oidcIssuerUrl: '…',
  oidcClientId: '…',
};
```

Two values, both about identity. The API address is absent by construction. The script runs when the container starts, so one image serves every environment.

`config.js` must be served with `Cache-Control: no-store`, while the hashed bundle assets are served as immutable. A cached `config.js` pointing at the previous environment's identity provider is a confusing failure.

### HTTP/2 in development, not only in production

`vite dev` serves HTTP/1.1 by default. Under ADR-025's connection pattern that caps development at six streams, and the failure mode is **requests hanging with no error** — indistinguishable from a backend fault, and the kind of thing that costs a day.

Two options for development, both acceptable:

- enable HTTP/2 on the Vite development server, or
- run the same nginx image in front of it

The second is more faithful to production, and also gives development the same-address `/api` path — so the app's own configuration doesn't differ between development and deployment.

Either way, this must be verified early rather than assumed.

### Port and script wiring

`EXPOSE_PORT_WEB` follows the existing convention. Host ports 3000, 3001, 3002, 3010–3013, 5432, 8080, 9000 and 9001 are taken; **5173** (Vite's default) and 4173 are free.

It is added in three places:

- `docker-compose.yml`
- `derive_host_urls` in `scripts/lib/derive-urls.sh`
- `scripts/lib/check-ports.sh` — which pre-flight-checks only API, DB, MinIO and Zitadel today, so a new service isn't covered unless it's added there

Note that `.env.example`'s comment claiming other ports are derived arithmetically from `EXPOSE_PORT_API` is stale — no code implements it. The web port is an independent variable, like the others.

### SPA routing

nginx falls back to `index.html` for any path that isn't a file and isn't `/api`, so React Router's deep links survive a page refresh.

Without it, loading `/company/acme` directly returns 404 — a classic and easily-missed deployment fault that only shows up on refresh, never during navigation.
