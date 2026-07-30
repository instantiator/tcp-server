# ADR-024: Browser OIDC Client and Token Handling

**Status:** Proposed (2026-07-30)

## Context

[ADR-017](ADR-017-oidc-provider-selection.md) chose Zitadel;
[ADR-011](ADR-011-authentication-authorization.md) established bearer JWTs
validated against the provider's JWKS. Neither is re-opened here. What is new is
the **client**: a public, browser-hosted SPA with no server-side session and no
place to keep a secret.

`tcp-cli` uses the Device Authorization Grant, chosen in ADR-017 because Zitadel
does not support ROPC. That flow is unchanged and stays as it is — the CLI and
the web app are two clients of the same provider, and the same
`scripts/start-deployment.sh` bootstrap must now create both.

The decisions that matter are the client library, and where tokens live.

## Options considered

### Library

| Option                   | Version / license                    | Trade-off                                                                                                                                                                         |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`react-oidc-context`** | 3.3.1, MIT, published 2026-03        | Thin React binding over `oidc-client-ts` — context provider, `useAuth()`, automatic renewal wiring. Same maintainers, released in lockstep                                        |
| `oidc-client-ts` alone   | 3.5.0, Apache-2.0, published 2026-03 | The engine underneath. Certified, actively maintained; using it directly means hand-writing the React lifecycle the wrapper already provides                                      |
| Hand-rolled PKCE         | —                                    | Auth Code + PKCE is roughly 150 lines of correctly-implemented crypto, state validation and nonce checking. Rejected: this is exactly the security-critical wheel not to reinvent |

### Token storage

| Option             | XSS blast radius                               | Survives reload      | Note                                                |
| ------------------ | ---------------------------------------------- | -------------------- | --------------------------------------------------- |
| **In-memory only** | A short-lived access token                     | No — re-auth on load | Most contained. Costs a redirect on every page load |
| `sessionStorage`   | A rotating refresh token, per tab              | Yes, per tab         | Cleared on tab close                                |
| `localStorage`     | A rotating refresh token, all tabs, persistent | Yes                  | Standard SPA practice, and the largest blast radius |

## Decision

**`react-oidc-context`, public client, Auth Code + PKCE, tokens in memory only,
re-authenticated by full-page redirect.**

### Why in-memory survives page reload without an iframe

The usual objection to in-memory tokens is that a reload logs the user out. It
does not, provided re-authentication uses a **full-page redirect** rather than a
hidden iframe.

This distinction is the whole decision. Silent renewal via a hidden iframe
depends on the provider's session cookie being readable in a cross-origin frame
— that is a third-party cookie, and modern browsers restrict it. Iframe-based
silent renew is on a path to simply not working.

A full-page redirect to Zitadel's authorize endpoint is a **first-party**
navigation. The session cookie applies normally. With an active Zitadel session
the user is redirected straight back, typically in a few hundred milliseconds and
without seeing a login form. The cost is a brief redirect on page load; the
benefit is that an XSS gets at most a short-lived access token, never a refresh
token, and that the mechanism does not degrade as browsers tighten cookie rules.

### Storage is a knob, not a rewrite

`oidc-client-ts` takes a pluggable `stateStore`/`userStore`. If the redirect on
reload proves unacceptable in practice, moving to `sessionStorage` is a
configuration change, not a redesign. It should be a recorded decision with the
trade-off above restated — not a quiet default that drifts in.

### The access token is fetched per request, never captured

Both the API fetch wrapper and the SSE reader obtain the current token from the
auth context **at call time**. Neither closes over a token value. A long-lived
component that captured a token at mount would keep presenting an expired one
long after renewal — and for a stream, would do so for hours.

### Token expiry mid-stream is specified here, not discovered

An SSE connection is authenticated once, when it opens. tcp-server does not
re-validate mid-stream, so an open stream keeps delivering events after its
token expires. Two consequences follow, and both are decisions:

1. **A long-lived stream outlives its credential.** Accepted for the MVP: the
   connection was authorised when established, and the alternative (periodic
   re-authentication of an open stream) has no support on either side today.
   Revocation therefore does not take effect until the stream drops.
2. **Reconnection must not reuse the expired token.** The reader obtains a fresh
   token on every connect attempt, so renewal happens naturally on reconnect.
   Without this, a network blip after expiry turns into a permanent 401 loop.

[ADR-025](ADR-025-browser-event-stream-consumption.md) owns the reconnect
mechanics; this is the credential half of the same problem.

### One 401 policy, shared

A 401 from any source — an API call or a stream connect — triggers one renewal
attempt, then a redirect to sign-in if that fails. The policy lives in one place
and both the fetch wrapper and the stream reader call it, so a token that has
genuinely gone does not produce a redirect from one code path and a silent
failure from the other.

### The Zitadel client is bootstrapped alongside the CLI's

`scripts/start-deployment.sh` already creates the project, application and users
for the device-flow client. It gains a second application registration: a public
client, PKCE required, no secret, with redirect and post-logout redirect URIs
derived from the web app's configured origin — not hardcoded, since the port
comes from `EXPOSE_PORT_WEB`
([ADR-029](ADR-029-spa-hosting-and-runtime-configuration.md)).

## Consequences

- A brief redirect to Zitadel and back on every full page load. Visible, and the
  price of not holding a refresh token in scriptable storage.
- The MVP requires an active Zitadel session for that redirect to be seamless.
  Once the provider session expires the user sees a login form — correct
  behaviour, and worth stating so it is not reported as a bug.
- `scripts/start-deployment.sh` grows a second application registration, and the
  generated client ID must reach the SPA's runtime configuration (ADR-029).
- Redirect URIs are environment-specific and must be derived, not hardcoded, or
  every non-default `EXPOSE_PORT_WEB` breaks sign-in with a provider-side error
  that does not name the cause.
- An open SSE stream outlives token expiry and therefore outlives revocation.
  Documented above as accepted; it is the one place where the security posture is
  weaker than a request-per-call model.
- The CLI's device flow is untouched. Both clients live in one Zitadel project.
- Profile data comes from ID token claims ([ADR-023](ADR-023-backend-api-surface-for-the-web-ui.md)),
  so the client must request the `profile` and `email` scopes — otherwise the
  profile dialog renders a subject ID and nothing else.

## Alternatives considered

- **Refresh token in `localStorage` with rotation.** The common SPA pattern, and
  Zitadel supports rotation. Rejected as the default: rotation limits replay
  after theft but does not prevent it, and an XSS on a page holding a refresh
  token owns the session for as long as it keeps rotating. Retained as the
  documented fallback if the reload redirect is unacceptable.
- **Iframe-based silent renew.** The traditional answer, and increasingly
  unreliable: it depends on third-party cookie access that browsers are removing.
  Rejected as building on a disappearing foundation.
- **A backend-for-frontend holding an httpOnly session cookie.** The strongest
  option — no token ever reaches JavaScript. Rejected for the MVP: it makes the
  static SPA stateful, turns the reverse proxy into an auth component with its own
  session store, and contradicts the "compiles to a SPA that can be hosted
  statically" requirement. The natural upgrade if this is ever exposed beyond a
  trusted network.
- **Hand-rolled PKCE.** Rejected: security-critical, well-solved, and the
  maintained libraries are certified against the conformance suite.

## Prompts to update when this is decided

- `002.03.00.prompt - static hosting and runtime configuration (draft).md`
- `004.01.00.prompt - oidc client (draft).md`
- `004.02.00.prompt - sign in (draft).md`
- `004.03.00.prompt - session persistence and sign out (draft).md`
- `005.01.00.prompt - generated api client (draft).md`
- `005.02.00.prompt - sse client and event handling (draft).md`
