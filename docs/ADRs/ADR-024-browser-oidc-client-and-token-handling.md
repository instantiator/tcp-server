# ADR-024: Browser OIDC Client and Token Handling

**Status:** Accepted (amended — see [004.01](#amendments-as-implemented-004-01) at the end)

## Context

[ADR-017](ADR-017-oidc-provider-selection.md) chose Zitadel as the identity provider. [ADR-011](ADR-011-authentication-authorization.md) established that the API accepts bearer tokens[^bearer], validated against the provider. Neither is re-opened here.

What's new is the **client**. A browser app is a _public_ client: it runs entirely on the user's machine, so it has no way to keep a secret. `tcp-cli` is different — it uses the device flow[^device], which stays as it is.

[^bearer]: A bearer token is a signed credential sent with each request. Whoever holds it can use it, so how long it lives and where it's stored both matter.

[^device]: The OAuth Device Authorization Grant — the flow where a terminal shows you a code to type into a browser. Chosen in ADR-017 because Zitadel doesn't support password grants.

## What needs deciding

1. **Which client library** handles the sign-in flow.
2. **Where tokens are stored** in the browser — the security decision in this ADR.

Storage is a real trade-off. Anything JavaScript can read, an XSS[^xss] attack can also read. Keeping a token only in memory is safest, but memory is cleared when the page reloads.

[^xss]: Cross-site scripting — an attack where hostile JavaScript runs on your page. It can read anything the page's own code can read.

## Options considered

### Library

| Option                   | Version / licence                    | Notes                                                                                                 |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **`react-oidc-context`** | 3.3.1, MIT, published 2026-03        | A thin React wrapper over `oidc-client-ts`. Same maintainers, released together                       |
| `oidc-client-ts` alone   | 3.5.0, Apache-2.0, published 2026-03 | The engine underneath. Certified and maintained; we'd hand-write the React parts the wrapper gives us |
| Hand-rolled              | —                                    | Security-critical code we'd have to get exactly right. Not worth reinventing                          |

### Token storage

| Option             | What an XSS attack gets                       | Survives page reload | Notes                                        |
| ------------------ | --------------------------------------------- | -------------------- | -------------------------------------------- |
| **In-memory only** | A short-lived access token                    | No — signs in again  | Safest. Costs a redirect when the page loads |
| `sessionStorage`   | A refresh token, for that tab                 | Yes, per tab         | Cleared when the tab closes                  |
| `localStorage`     | A refresh token, every tab, kept indefinitely | Yes                  | Common SPA practice, and the widest exposure |

## Decision

**`react-oidc-context`, as a public client using Authorization Code with PKCE[^pkce]. Tokens are held in memory only, and the user is re-authenticated by a full-page redirect.**

The usual objection to in-memory tokens is that a page reload signs the user out. It doesn't — provided re-authentication uses a full-page redirect rather than a hidden iframe. See [why in-memory survives a reload](#why-in-memory-survives-a-page-reload).

Storage is a configuration setting, not a rewrite. If the redirect proves annoying in practice, moving to `sessionStorage` is [a small configuration change](#storage-is-a-small-configuration-change-not-a-rewrite) — but it should be a recorded decision, with the trade-off restated.

- The access token is [fetched per request, never captured](#the-access-token-is-fetched-per-request) — otherwise a long-lived component keeps presenting an expired one.
- [One shared 401 policy](#one-401-policy-shared) covers both API calls and event streams.
- [Token expiry during an open stream](#token-expiry-during-an-open-stream) is specified here rather than discovered later.

[^pkce]: Proof Key for Code Exchange — an extension that lets an app with no secret prove it started the sign-in it's now completing. The standard approach for browser and mobile apps.

## Consequences

- A brief redirect to Zitadel and back on every full page load. It's visible, and it's the price of not keeping a long-lived token where scripts can read it.
- That redirect is only seamless while the user has an active Zitadel session. Once the provider's session expires they see a login form — correct behaviour, worth stating so it isn't reported as a bug.
- `scripts/start-deployment.sh` gets a second application registration, and the generated client ID has to reach the app's runtime configuration ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).
- Redirect URLs are environment-specific and must be derived, not hardcoded, or any non-default web port breaks sign-in with a provider-side error that doesn't name the cause.
- **An open event stream outlives token expiry, and therefore outlives revocation.** This is the one place the security posture is weaker than a request-by-request model. Accepted for the MVP; see the Detail section.
- The CLI's device flow is untouched. Both clients live in one Zitadel project.
- The app must ask for the `profile` and `email` scopes, or the profile dialog ([ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md)) shows an ID and nothing else.

## Alternatives considered

- **Refresh token in `localStorage`, with rotation.** The common SPA pattern, and Zitadel supports it. Rejected as the default: rotation limits how long a stolen token is useful, but doesn't stop the theft, and an XSS on a page holding one owns the session for as long as it keeps rotating. Kept as the documented fallback.
- **Hidden-iframe silent renewal.** The traditional answer, and increasingly unreliable — it depends on third-party cookie access that browsers are removing. Rejected because it depends on something that is actively being taken away, not just a mechanism with rough edges.
- **A backend-for-frontend holding a session cookie.** The strongest option: no token ever reaches JavaScript. Rejected for the MVP because it makes the static app stateful and contradicts the "hosted statically" requirement. It's the natural upgrade if this is ever exposed beyond a trusted network.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `004.01.00.prompt - oidc client (draft).md`
- `004.02.00.prompt - sign in (draft).md`
- `004.03.00.prompt - session persistence and sign out (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `005.02.00.prompt - sse client and event handling (draft).md`

## Detail

### Why in-memory survives a page reload

The distinction that carries this decision is **full-page redirect versus hidden iframe**.

Silent renewal in a hidden iframe depends on the provider's session cookie being readable inside a cross-origin frame. That's a third-party cookie, and browsers are increasingly blocking them — so iframe-based renewal is likely to stop working, not just occasionally fail.

A full-page redirect to Zitadel is a **first-party** navigation. The session cookie applies normally. With an active session the user is redirected straight back, usually in a few hundred milliseconds and without seeing a login form.

So the cost is a brief redirect on page load. The benefit is that an XSS gets at most a short-lived access token, never a refresh token — and the mechanism doesn't degrade as browsers tighten cookie rules.

### Storage is a small configuration change, not a rewrite

`oidc-client-ts` takes a pluggable store. Moving from memory to `sessionStorage` is a configuration change.

It should not drift in as a quiet default. If it changes, the trade-off in the options table above applies and should be recorded.

### The access token is fetched per request

Both the API fetch wrapper and the event-stream reader ask the auth context for the current token **at the moment they need it**. Neither holds onto a token value.

A component that captured a token when it mounted would keep presenting an expired one long after renewal — and for a stream, would do so for hours.

### One 401 policy, shared

A 401 from any source — an API call or a stream connection — triggers one renewal attempt, then a redirect to sign-in if that fails.

The policy lives in one place, and both the fetch wrapper and the stream reader call it. Otherwise a token that has genuinely gone produces a redirect from one code path and a silent failure from the other.

### Token expiry during an open stream

An SSE connection is authenticated once, when it opens. tcp-server doesn't re-check mid-stream, so an open stream keeps delivering events after its token expires.

Two consequences, both decisions:

1. **A long-lived stream outlives its credential.** Accepted for the MVP — the connection was authorised when it was established, and re-authenticating an open stream isn't supported at either end today. Revocation therefore doesn't take effect until the stream drops.
2. **Reconnection must not reuse the expired token.** The reader gets a fresh token on every connection attempt, so renewal happens naturally on reconnect. Without this, a network blip after expiry becomes a permanent 401 loop.

[ADR-025](ADR-025-browser-event-stream-consumption.md) owns the reconnection mechanics; this is the credential half of the same problem.

### Registering the web client with Zitadel

`scripts/start-deployment.sh` already creates the project, application and users for the CLI's device flow. It gains a second application registration: a public client, PKCE required, no secret, with redirect and post-logout URLs derived from the web app's configured address — not hardcoded, since the port comes from `EXPOSE_PORT_WEB` ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).

<a id="amendments-as-implemented-004-01"></a>

## Amendments as implemented (004.01)

The `UserManager` singleton, `getAccessToken()` and `handleUnauthorized()` now exist (`apps/frontend/tcp-frontend/src/auth/`), along with the second Zitadel registration. Five points where the implementation is more specific than the decision above, or diverges from it in a way that must not read afterwards as an oversight.

(a) **The renewal and the sign-in are the same redirect.** This ADR asks for "one renewal attempt, then a redirect to sign-in if that fails" — two steps. With no refresh token, there is nothing to renew with, and a hidden-iframe renewal is exactly the mechanism [Decision](#decision) rejected. `handleUnauthorized()` therefore makes one deduplicated `signinRedirect()` and lets the provider decide whether a login form is needed: with a live session the user bounces straight back, which _is_ the renewal; without one, they see the form, which _is_ the sign-in. This is only correct because no refresh token exists — it is coupled to the in-memory storage decision, not a general substitute for a two-step policy.

(b) **The PKCE verifier and `state` live in `sessionStorage`, not memory.** Both have to survive the navigation to the provider and back, so memory isn't an option the way it is for tokens. Neither is a token, though: each is single-use, scoped to one sign-in attempt, and worthless to an attacker who cannot also receive the callback. The storage test asserts the narrower and accurate property this ADR's threat model actually cares about — no _token_ reaches browser storage — rather than the stronger and false claim that nothing OIDC-related does.

(c) **`AuthProvider` is deferred to 004.02.** Nothing in the tree consumes an auth context yet, and the two real consumers of a token — a fetch wrapper and a stream reader — are not components and cannot read one. `getUserManager()`'s module singleton is the shared instance; 004.02 must mount `AuthProvider` **around this instance**, not around a second set of settings, or the app ends up with two managers holding two different in-memory users.

(d) **The local registration uses Zitadel `devMode: true`**, which relaxes redirect-URI validation for `localhost`. Correct for a self-signed localhost bootstrap; wrong for the first deployment on a hostname that isn't `localhost`, at which point this needs revisiting rather than carrying forward unexamined.

(e) **`loadUserInfo` is a runtime setting, `OIDC_LOAD_USER_INFO`, not a constant.** It reaches the client through `config.js` ([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)), so a provider whose ID token omits the `profile`/`email` claims is a variable change rather than a rebuild. This is what keeps the standards-only claim in [Decision](#decision) true in practice as well as in principle: Zitadel puts both claims in the ID token, but nothing in the client code assumes every provider will.
