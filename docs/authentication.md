# Authentication

tcp-server uses OIDC/OAuth 2.0 for authentication. Any standards-compliant OIDC provider
is supported. Zitadel is included in the Docker Compose setup for local development; for
production you can swap it out for Auth0, Okta, Azure AD, or any other provider.

## How it works

1. Clients obtain an access token from the OIDC provider — directly, or via tcp-server's
   device-authorization proxy (`POST /api/auth/device` + `POST /api/auth/device/token`,
   see [Getting tokens for development](#getting-tokens-for-development-tcp-cli-get-token)),
   used by `tcp-cli get-token`.
2. Clients include the token as a `Bearer` header on every request to a guarded endpoint.
3. tcp-server validates the token by fetching the provider's public keys from its JWKS
   endpoint (discovered automatically from `OIDC_ISSUER_URL/.well-known/openid-configuration`
   at startup) and verifying the signature, expiry, and issuer claims.

   **Zitadel issues opaque (JWE-encrypted), not JWT, access tokens by default.** A token
   in that shape can't even be parsed by passport-jwt/JWKS verification — every OIDC
   application and machine user must be created with `accessTokenType:
OIDC_TOKEN_TYPE_JWT` (apps) or `ACCESS_TOKEN_TYPE_JWT` (machine users), or auth breaks
   outright. `scripts/start-deployment.sh` sets this correctly for the resources it
   creates; it's the single easiest thing to get wrong when hand-configuring Zitadel
   yourself (see [docs/zitadel-setup.md](zitadel-setup.md)).

## Authorization

Authentication proves who the caller is. **Authorization decides which company
they may reach**, and since 002.05 it is enforced on every user-facing route
([ADR-011](ADRs/ADR-011-authentication-authorization.md#amendments-as-implemented-00205)).

### Membership

A caller reaches a company if a `CompanyUser` row exists for it whose
`identifier` matches the token's `sub` **or** its `email`. Both forms are
checked: a membership added by email address grants access exactly as one added
by `sub` does. `POST /api/company` adds the creator's row automatically.

Most routes don't name a company directly. The company is resolved from
whatever the route does name — a task, agent, assignment, role, conversation
slug, or the company-slug prefix of a storage key — so reaching a company's task
as a non-member fails just as reaching the company does.

**A refusal is a `403`, not an empty result.** A non-member asking for a
company is told so rather than handed a filtered-down answer that looks like the
company is empty. A `404` means the id names nothing at all; the two are kept
distinct so a permissions problem never reads as a missing record.

<a id="administrators"></a>

### Administrators

Two things sit above membership: `?all=true` on `GET /api/company` (every
company, not just the caller's) and the `/api/system` shutdown routes.
`TCP_ADMIN_IDENTIFIERS` names who may use them — comma-separated `sub` claims
and/or email addresses. Administrators also reach any company without a
membership row, which is how an operator administers a system they are not a
member of.

**It is empty by default: nobody is an administrator.** Forgetting to set it
costs you an administrative view; it never grants one by accident.

With the bundled Zitadel, `scripts/start-deployment.sh` writes the bootstrapped
human and machine user ids into the gitignored `<env-file>.local` override, so
`tcp-cli` and the api test tier work without further setup. Against an external
provider, set it yourself — the values are the `sub` claims (or email addresses)
your provider issues.

This is deliberately a flat list. Permission groups, and the per-action
permission flags ADR-011 describes, are still deferred: **any member of a
company may take any action within it.**

### What is not covered

`/internal/*` is a different trust boundary, guarded by the `X-Internal-Api-Key`
shared secret rather than a JWT, and carries no membership check — tcp-agent and
the MCP servers hold no membership and need none. Do not expose those routes
outside the Compose network.

## Environment variables

| Variable                   | Required  | Description                                                                                                                                                                                                                                                                                   |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER_URL`          | **Yes**   | The provider's issuer URL. Must match the `iss` claim in tokens. Committed.                                                                                                                                                                                                                   |
| `OIDC_CLIENT_ID`           | **Yes**   | Client ID. Generated (bundled Zitadel) or provider-issued (external) — lives in the gitignored `<env>.local`, not committed.                                                                                                                                                                  |
| `OIDC_CLIENT_SECRET`       | **Yes**   | Client secret (used server-side by the device-authorization and refresh endpoints). Same `.local` placement as the client ID.                                                                                                                                                                 |
| `OIDC_WEB_CLIENT_ID`       | **Yes**\* | Client ID for the browser's public PKCE client (see [Browser sign-in](#browser-sign-in-authorization-code-with-pkce)). Generated (bundled Zitadel) or provider-issued (external) — same gitignored `.local` placement as `OIDC_CLIENT_ID`. \*Required by `tcp-web`, not by tcp-server itself. |
| `OIDC_INTERNAL_ISSUER_URL` | No        | Alternative URL for server-side HTTP calls to the provider (see [Docker networking](#docker-networking)).                                                                                                                                                                                     |
| `OIDC_JWKS_URI`            | No        | Explicit JWKS URI override. If unset, discovered from the provider's discovery document.                                                                                                                                                                                                      |
| `OIDC_AUDIENCE`            | No        | Audience claim to validate. If unset, audience validation is skipped (see [Audience validation](#audience-validation)).                                                                                                                                                                       |
| `OIDC_LOAD_USER_INFO`      | No        | Whether the browser client reads `profile`/`email` from the provider's userinfo endpoint instead of the ID token. Defaults to `false`. The symptom that calls for `true`: a profile dialog showing a bare subject identifier even though the client requested the `profile`/`email` scopes.   |
| `TCP_ADMIN_IDENTIFIERS`    | No        | Comma-separated `sub` claims and/or emails permitted to use `?all=true` and the `/api/system` routes. Empty means nobody (see [Administrators](#administrators)).                                                                                                                             |

## Using the included Zitadel (local development)

The Docker Compose file includes Zitadel under the `auth` profile. `start-dev.sh`
starts it and performs first-time configuration automatically.

```bash
./scripts/start-dev.sh
```

This creates:

- Org: `tcp`
- Application: `tcp-server` (OIDC, device authorization + refresh token grants)
- Application: `tcp-web` (OIDC, public client, Authorization Code + PKCE — see [Browser sign-in](#browser-sign-in-authorization-code-with-pkce))
- Test user: `test` / `test`

Zitadel is then accessible at `http://localhost:8080/ui/console` (admin console). The
bootstrap generates the OIDC client credentials and writes them to the gitignored
`<env-file>.local` override (e.g. `.env.dev.local`); tcp-server reads them from there —
nothing to configure by hand.

See [docs/zitadel-setup.md](zitadel-setup.md) for manual configuration steps.

## Browser sign-in (Authorization Code with PKCE)

`tcp-web` is a second, separate OIDC client from `tcp-server`'s — and it has to be,
because a browser can't keep a secret the way a server can. Anyone with the developer
console open can read the client's source, so `tcp-web` is registered as a **public**
client with no client secret at all. In its place, the Authorization Code flow runs with
PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)), which lets the client prove it
started the sign-in it's now completing without ever holding a secret to protect.

**Tokens live in memory only** — never in `localStorage` or `sessionStorage` — so an XSS
attack can read at most the short-lived access token that happens to be current, never
anything longer-lived. The cost is that a full page reload clears them: the app
re-authenticates with a full-page redirect to the provider rather than a hidden iframe,
because iframe-based silent renewal depends on reading the provider's session cookie
across origins, and browsers are actively removing that. With a live provider session the
redirect is seamless — the user bounces back with a fresh token in well under a second and
never sees a form. Once that session has expired, they see the provider's login page,
which is correct behaviour rather than a bug to chase.

The client requests the `openid profile email` scopes, so the eventual profile view has
more than a bare subject identifier to show. Its redirect and post-logout URLs are derived
from `EXPOSE_PORT_WEB` over **https** — `tcp-web` is TLS-only
([ADR-025](ADRs/ADR-025-browser-event-stream-consumption.md),
[ADR-029](ADRs/ADR-029-spa-hosting-and-runtime-configuration.md)) — rather than
hardcoded, so a non-default port never disagrees with what was registered.

The browser journey built on top of this — the control, the redirect, the `/callback`
route and the validated return address — is described in
[the web client guide](web-client.md#signing-in). Session persistence across a reload,
token expiry while the app is open, and sign-out are covered next.

### Sessions, expiry and revocation in the browser

Tokens live in memory only, so nothing survives a page reload on its own.
`RequireSession` recovers the same way sign-in itself does: it calls
`handleUnauthorized()`, the one deduplicated `signinRedirect()` above. Against
an active provider session that's a full-page round trip of a few hundred
milliseconds and no visible form; against an expired one, the provider's login
page appears, which is the correct outcome rather than a bug. A visible warning
appears 30 seconds before the access token expires, with a **Stay signed in**
control that makes the same redirect on demand — [WCAG 2.2.1](https://www.w3.org/WAI/WCAG22/Understanding/timing-adjustable.html)
requires a timed session to be extendable, not merely noticed. Ignoring the
warning removes the signed-in user once the token actually expires, so the
account menu disappears rather than staying on screen pointing at a token that
no longer works. Signing out from the account menu ends the session at the
provider as well as locally.

**Accepted limitation: an open event stream outlives revocation.** tcp-server
authenticates a stream once, when it opens, and never re-checks it — so
revoking a user does not take effect until that stream drops, however the
revocation happened. This is decided in
[ADR-024](ADRs/ADR-024-browser-oidc-client-and-token-handling.md#token-expiry-during-an-open-stream)
and accepted for the MVP. There is no browser stream client to observe this in
yet — it arrives with 005.02 — so an operator revoking a user today isn't
hunting for behaviour that hasn't shipped; this is recorded here so it isn't a
surprise once it has.

**Multi-tab caveat.** `monitorSession` is off, so signing out in one tab
doesn't notify another: a second tab keeps showing a signed-in-looking header
until its next request is refused with a 401.

## Using an external OIDC provider

Set `OIDC_ISSUER_URL` in your committed env file, and put the provider-issued
`OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` in the gitignored `<env-file>.local` override (the
`.env` snippets below show the combined effect). `OIDC_INTERNAL_ISSUER_URL` is not needed
for external providers.

The browser client is plain OIDC, so the same swap extends to it rather than needing its
own configuration. Register a **public** client using Authorization Code with PKCE — no
secret — with redirect URI `https://<web-host>/callback`, post-logout redirect URI
`https://<web-host>/`, and scopes `openid profile email`. `OIDC_ISSUER_URL`,
`OIDC_WEB_CLIENT_ID` and, optionally, `OIDC_LOAD_USER_INFO` are the only values that
change: put the provider-issued client ID in `<env-file>.local` as `OIDC_WEB_CLIENT_ID`,
and set `OIDC_LOAD_USER_INFO=true` if the provider's ID token omits `profile`/`email` —
Zitadel's does not, which is why the bundled stack never sets it.

### Auth0

```env
OIDC_ISSUER_URL=https://your-tenant.auth0.com/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=https://your-api-identifier
```

Set `OIDC_AUDIENCE` to the API identifier you configured in Auth0. Auth0 access tokens
include this value in the `aud` claim.

Note: `tcp-cli get-token` uses the OAuth 2.0 Device Authorization Grant — enable the
"Device Code" grant type on your Auth0 application if you want the CLI login flow to
work. If unavailable, obtain tokens through Auth0's standard flows and pass them with
`--access-token`.

### Okta

```env
OIDC_ISSUER_URL=https://your-org.okta.com/oauth2/default
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=api://default
```

Okta supports the Device Authorization Grant — enable it in the application's grant
type settings if you want `tcp-cli get-token` to work.

### Azure Active Directory (Microsoft Entra)

```env
OIDC_ISSUER_URL=https://login.microsoftonline.com/{tenant-id}/v2.0
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=api://{client-id}
```

Azure AD supports the Device Authorization Grant — enable "Allow public client flows"
under the application's Authentication settings if you want `tcp-cli get-token` to work.

### Generic OIDC provider

Any provider that publishes a standards-compliant discovery document at
`{issuer}/.well-known/openid-configuration` with a `jwks_uri` field will work without
further configuration. Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.

If your provider does not support discovery, set `OIDC_JWKS_URI` explicitly:

```env
OIDC_JWKS_URI=https://your-provider.example.com/oauth2/keys
```

## Docker networking

When tcp-server runs inside Docker Compose alongside a self-hosted provider (e.g.
Zitadel), the provider's public URL (e.g. `http://localhost:8080`) is not reachable from
inside the container. Use `OIDC_INTERNAL_ISSUER_URL` to provide the container-to-container
URL:

```env
OIDC_ISSUER_URL=http://localhost:8080          # external — matches iss claim in tokens
OIDC_INTERNAL_ISSUER_URL=http://zitadel:8080   # internal — used for HTTP calls
```

- `OIDC_ISSUER_URL` is used for JWT `iss` validation only (must match what the provider puts in tokens).
- `OIDC_INTERNAL_ISSUER_URL` is used for all server-side HTTP calls to the provider
  (JWKS discovery, token endpoint discovery, token requests).

Zitadel does strict Host-header-based instance routing: it returns 404 "Instance not
found" for a request whose `Host` header doesn't match `ZITADEL_EXTERNALDOMAIN`, which is
exactly what happens for an internal Docker-network request reached via
`OIDC_INTERNAL_ISSUER_URL` (its `Host` is `zitadel:8080`, not the configured external
domain). To work around this, `jwt.strategy.ts` and `auth-token.service.ts` forward an
`X-Forwarded-Host: <external issuer host>` header on every internal request, so Zitadel
can still resolve the right instance while the request travels over the internal network.
This is harmless for providers that don't need it (internal and external host already
match, or the provider ignores the header).

For external providers (Auth0, Okta, etc.) accessed over the internet from inside Docker,
this split is not needed — set only `OIDC_ISSUER_URL`.

## Audience validation

The `aud` claim in access tokens identifies the intended recipient of the token. Behaviour
varies by provider:

| Provider / scenario         | `aud` value                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| Zitadel (default)           | The requesting client ID, as an array (e.g. `aud: ["<client_id>"]`) |
| Auth0 (with API configured) | Your API identifier                                                 |
| Okta                        | `api://default` or your custom audience                             |

By default tcp-server does not validate `aud` (the issuer check is sufficient for
single-tenant deployments). To enable it, set `OIDC_AUDIENCE` to the expected value —
for Zitadel, that's simply your `OIDC_CLIENT_ID`; no mapper or extra configuration is
needed.

## Getting tokens for development (`tcp-cli get-token`)

tcp-server proxies the OAuth 2.0 Device Authorization Grant
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) so the OIDC client secret never
leaves the server. This is what `tcp-cli get-token` uses.

### `POST /api/auth/device`

Starts a device authorization flow. No request body.

```http
POST /api/auth/device
```

Returns:

```json
{
  "device_code": "...",
  "user_code": "ABCD-EFGH",
  "verification_uri": "http://localhost:8080/device",
  "verification_uri_complete": "http://localhost:8080/device?user_code=ABCD-EFGH",
  "expires_in": 300,
  "interval": 5
}
```

Present `verification_uri`/`user_code` (or open `verification_uri_complete` directly) to
a human, who completes login in a browser.

### `POST /api/auth/device/token`

Polls for the outcome of a device authorization started above.

```http
POST /api/auth/device/token
Content-Type: application/json

{ "device_code": "..." }
```

Returns `{ "status": "pending" }` or `{ "status": "slow_down" }` while the human hasn't
finished logging in yet, or the token response once they have:

```json
{
  "status": "complete",
  "access_token": "...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "..."
}
```

### `POST /api/auth/refresh`

Exchanges a refresh token for a new access token — unchanged, still proxies the standard
`refresh_token` grant.

```http
POST /api/auth/refresh
Content-Type: application/json

{ "refresh_token": "..." }
```

**Note:** Zitadel does not support the Resource Owner Password Credentials (ROPC /
password) grant under any configuration — it's dropped ahead of OAuth 2.1 for exposing
user passwords directly to the client. That's why `tcp-cli get-token` uses the device
flow above instead of a username/password prompt. If your external OIDC provider doesn't
support the device authorization grant either, obtain tokens through its standard flows
and pass them to tcp-cli with `--access-token <token>`.
