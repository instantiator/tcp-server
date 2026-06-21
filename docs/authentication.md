# Authentication

lcp-server uses OIDC/OAuth 2.0 for authentication. Any standards-compliant OIDC provider
is supported. Keycloak is included in the Docker Compose setup for local development; for
production you can swap it out for Auth0, Okta, Azure AD, or any other provider.

## How it works

1. Clients obtain an access token from the OIDC provider (directly, or via
   `POST /api/auth/token` if the provider supports the Resource Owner Password Credentials grant).
2. Clients include the token as a `Bearer` header on every request to a guarded endpoint.
3. lcp-server validates the token by fetching the provider's public keys from its JWKS
   endpoint (discovered automatically from `OIDC_ISSUER_URL/.well-known/openid-configuration`
   at startup) and verifying the signature, expiry, and issuer claims.

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_ISSUER_URL` | **Yes** | The provider's issuer URL. Must match the `iss` claim in tokens. |
| `OIDC_CLIENT_ID` | **Yes** | Client ID registered with the provider. |
| `OIDC_CLIENT_SECRET` | **Yes** | Client secret (used by the token proxy endpoint). |
| `OIDC_INTERNAL_ISSUER_URL` | No | Alternative URL for server-side HTTP calls to the provider (see [Docker networking](#docker-networking)). |
| `OIDC_JWKS_URI` | No | Explicit JWKS URI override. If unset, discovered from the provider's discovery document. |
| `OIDC_AUDIENCE` | No | Audience claim to validate. If unset, audience validation is skipped (see [Audience validation](#audience-validation)). |

## Using the included Keycloak (local development)

The Docker Compose file includes Keycloak under the `auth` profile. `start-dev.sh`
starts it and performs first-time configuration automatically.

```bash
./scripts/dev/start-dev.sh
```

This creates:
- Realm: `lcp`
- Client: `lcp-server` (direct access grants enabled)
- Test user: `test` / `test`

Keycloak is then accessible at `http://localhost:8080` (admin console) and lcp-server
is configured to use it automatically via the defaults in `.env.example`.

See [docs/keycloak-setup.md](keycloak-setup.md) for manual configuration steps.

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

Note: Auth0's ROPC grant (`grant_type=password`) requires the "Password" grant type to
be enabled on the application and is only available on certain plan tiers. If unavailable,
the `lcp-cli get-token` verb will not work — obtain tokens via Auth0's standard flows and
pass them with `--access-token`.

### Okta

```env
OIDC_ISSUER_URL=https://your-org.okta.com/oauth2/default
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=api://default
```

Okta supports ROPC when "Resource Owner Password" is enabled in the application settings.

### Azure Active Directory (Microsoft Entra)

```env
OIDC_ISSUER_URL=https://login.microsoftonline.com/{tenant-id}/v2.0
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_AUDIENCE=api://{client-id}
```

Azure AD supports ROPC for certain scenarios but it is not recommended for new applications.

### Generic OIDC provider

Any provider that publishes a standards-compliant discovery document at
`{issuer}/.well-known/openid-configuration` with a `jwks_uri` field will work without
further configuration. Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET`.

If your provider does not support discovery, set `OIDC_JWKS_URI` explicitly:

```env
OIDC_JWKS_URI=https://your-provider.example.com/oauth2/keys
```

## Docker networking

When lcp-server runs inside Docker Compose alongside a self-hosted provider (e.g. Keycloak),
the provider's public URL (e.g. `http://localhost:8080`) is not reachable from inside the
container. Use `OIDC_INTERNAL_ISSUER_URL` to provide the container-to-container URL:

```env
OIDC_ISSUER_URL=http://localhost:8080/realms/lcp         # external — matches iss claim in tokens
OIDC_INTERNAL_ISSUER_URL=http://keycloak:8080/realms/lcp # internal — used for HTTP calls
```

- `OIDC_ISSUER_URL` is used for JWT `iss` validation only (must match what the provider puts in tokens).
- `OIDC_INTERNAL_ISSUER_URL` is used for all server-side HTTP calls to the provider
  (JWKS discovery, token endpoint discovery, token requests).

For external providers (Auth0, Okta, etc.) accessed over the internet from inside Docker,
this split is not needed — set only `OIDC_ISSUER_URL`.

## Audience validation

The `aud` claim in access tokens identifies the intended recipient of the token. Behaviour
varies by provider and grant type:

| Provider / scenario | `aud` value |
|---------------------|-------------|
| Keycloak (ROPC, default client config) | `account` |
| Auth0 (with API configured) | Your API identifier |
| Okta | `api://default` or your custom audience |
| Keycloak (with audience mapper configured) | Your configured value |

By default lcp-server does not validate `aud` (the issuer check is sufficient for
single-tenant deployments). To enable it, set `OIDC_AUDIENCE` to the expected value.

For Keycloak, you can add an audience mapper to include a custom value in tokens:
Keycloak admin → Client → your client → Client scopes → Add mapper → Audience.

## The token proxy endpoint (`POST /api/auth/token`)

```
POST /api/auth/token
Content-Type: application/json

{ "username": "alice", "password": "s3cret" }
```

This endpoint proxies the OIDC Resource Owner Password Credentials (ROPC) grant
so the OIDC client secret never leaves the server. It is used by `lcp-cli get-token`.

**Limitations:**
- ROPC is deprecated in OAuth 2.1 and not supported by all providers.
- It requires a confidential client (one with a `client_secret`).
- Auth0 restricts ROPC to specific plan tiers; Azure AD discourages it for new apps.

If ROPC is not available, obtain tokens through your provider's standard flows (browser
redirect, device code, etc.) and pass them to lcp-cli with `--access-token <token>`.
