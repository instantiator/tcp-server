# Authentication

lcp-server uses OIDC/OAuth 2.0 for authentication. Any standards-compliant OIDC provider
is supported. Zitadel is included in the Docker Compose setup for local development; for
production you can swap it out for Auth0, Okta, Azure AD, or any other provider.

## How it works

1. Clients obtain an access token from the OIDC provider — directly, or via lcp-server's
   device-authorization proxy (`POST /api/auth/device` + `POST /api/auth/device/token`,
   see [Getting tokens for development](#getting-tokens-for-development-lcp-cli-get-token)),
   used by `lcp-cli get-token`.
2. Clients include the token as a `Bearer` header on every request to a guarded endpoint.
3. lcp-server validates the token by fetching the provider's public keys from its JWKS
   endpoint (discovered automatically from `OIDC_ISSUER_URL/.well-known/openid-configuration`
   at startup) and verifying the signature, expiry, and issuer claims.

   **Zitadel issues opaque (JWE-encrypted), not JWT, access tokens by default.** A token
   in that shape can't even be parsed by passport-jwt/JWKS verification — every OIDC
   application and machine user must be created with `accessTokenType:
OIDC_TOKEN_TYPE_JWT` (apps) or `ACCESS_TOKEN_TYPE_JWT` (machine users), or auth breaks
   outright. `scripts/start-deployment.sh` sets this correctly for the resources it
   creates; it's the single easiest thing to get wrong when hand-configuring Zitadel
   yourself (see [docs/zitadel-setup.md](zitadel-setup.md)).

## Environment variables

| Variable                   | Required | Description                                                                                                             |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER_URL`          | **Yes**  | The provider's issuer URL. Must match the `iss` claim in tokens.                                                        |
| `OIDC_CLIENT_ID`           | **Yes**  | Client ID registered with the provider.                                                                                 |
| `OIDC_CLIENT_SECRET`       | **Yes**  | Client secret (used server-side by the device-authorization and refresh endpoints).                                     |
| `OIDC_INTERNAL_ISSUER_URL` | No       | Alternative URL for server-side HTTP calls to the provider (see [Docker networking](#docker-networking)).               |
| `OIDC_JWKS_URI`            | No       | Explicit JWKS URI override. If unset, discovered from the provider's discovery document.                                |
| `OIDC_AUDIENCE`            | No       | Audience claim to validate. If unset, audience validation is skipped (see [Audience validation](#audience-validation)). |

## Using the included Zitadel (local development)

The Docker Compose file includes Zitadel under the `auth` profile. `start-dev.sh`
starts it and performs first-time configuration automatically.

```bash
./scripts/start-dev.sh
```

This creates:

- Org: `lcp`
- Application: `lcp-server` (OIDC, device authorization + refresh token grants)
- Test user: `test` / `test`

Zitadel is then accessible at `http://localhost:8080/ui/console` (admin console) and
lcp-server is configured to use it automatically via the defaults in `.env.example`.

See [docs/zitadel-setup.md](zitadel-setup.md) for manual configuration steps.

## Using an external OIDC provider

Set the three required variables in your environment or `.env` file and start lcp-server
normally. `OIDC_INTERNAL_ISSUER_URL` is not needed for external providers.

### Auth0

```env
OIDC_ISSUER_URL=https://your-tenant.auth0.com/
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=https://your-api-identifier
```

Set `OIDC_AUDIENCE` to the API identifier you configured in Auth0. Auth0 access tokens
include this value in the `aud` claim.

Note: `lcp-cli get-token` uses the OAuth 2.0 Device Authorization Grant — enable the
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
type settings if you want `lcp-cli get-token` to work.

### Azure Active Directory (Microsoft Entra)

```env
OIDC_ISSUER_URL=https://login.microsoftonline.com/{tenant-id}/v2.0
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=api://{client-id}
```

Azure AD supports the Device Authorization Grant — enable "Allow public client flows"
under the application's Authentication settings if you want `lcp-cli get-token` to work.

### Generic OIDC provider

Any provider that publishes a standards-compliant discovery document at
`{issuer}/.well-known/openid-configuration` with a `jwks_uri` field will work without
further configuration. Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.

If your provider does not support discovery, set `OIDC_JWKS_URI` explicitly:

```env
OIDC_JWKS_URI=https://your-provider.example.com/oauth2/keys
```

## Docker networking

When lcp-server runs inside Docker Compose alongside a self-hosted provider (e.g.
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

By default lcp-server does not validate `aud` (the issuer check is sufficient for
single-tenant deployments). To enable it, set `OIDC_AUDIENCE` to the expected value —
for Zitadel, that's simply your `OIDC_CLIENT_ID`; no mapper or extra configuration is
needed.

## Getting tokens for development (`lcp-cli get-token`)

lcp-server proxies the OAuth 2.0 Device Authorization Grant
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)) so the OIDC client secret never
leaves the server. This is what `lcp-cli get-token` uses.

### `POST /api/auth/device`

Starts a device authorization flow. No request body.

```
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

```
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

```
POST /api/auth/refresh
Content-Type: application/json

{ "refresh_token": "..." }
```

**Note:** Zitadel does not support the Resource Owner Password Credentials (ROPC /
password) grant under any configuration — it's dropped ahead of OAuth 2.1 for exposing
user passwords directly to the client. That's why `lcp-cli get-token` uses the device
flow above instead of a username/password prompt. If your external OIDC provider doesn't
support the device authorization grant either, obtain tokens through its standard flows
and pass them to lcp-cli with `--access-token <token>`.
