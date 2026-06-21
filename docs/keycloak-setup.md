# Keycloak Setup Guide

LCP uses an OIDC-compatible IdP for authentication. Keycloak is the default, provided as an optional Docker Compose service.

## Automated local setup

For local development, `scripts/dev/start-dev.sh` handles everything below automatically — it starts all services, creates the `lcp` realm and `lcp-server` client, and adds a test user:

```bash
./scripts/dev/start-dev.sh                          # uses .env or .env.testing
./scripts/dev/start-dev.sh -e .env.local            # use a custom env file
./scripts/dev/start-dev.sh --test-username alice --test-password s3cret
```

The manual steps below are for reference, custom IdP configuration, or production setup.

## Start Keycloak

```bash
docker compose --profile auth up -d keycloak
```

Wait for Keycloak to be healthy (may take up to 60s on first boot):

```bash
until curl -sf http://localhost:8080/health/ready; do sleep 5; done
echo "Keycloak ready"
```

## Initial realm and client setup

1. Open http://localhost:8080 and log in with `admin` / the `KEYCLOAK_ADMIN_PASSWORD` from your `.env`.
2. Create a realm named **`lcp`** (top-left dropdown → Create realm).
3. In the `lcp` realm, go to **Clients → Create client**:
   - Client ID: `lcp-server`
   - Client authentication: **On** (confidential client)
   - Service accounts enabled: **On** (for admin API calls from lcp-server)
   - Valid redirect URIs: `http://localhost:3000/*`
4. After saving, go to the **Credentials** tab and copy the client secret into `.env`:
   ```
   OIDC_CLIENT_SECRET=<copied-secret>
   ```
5. Set `OIDC_ISSUER_URL=http://localhost:8080/realms/lcp` in `.env`.

## Service account for user management

lcp-server calls Keycloak's Admin REST API to create and manage users. Grant the `lcp-server` service account the `realm-admin` role:

1. Clients → `lcp-server` → **Service accounts roles** tab
2. Assign role: `realm-admin` (from `realm-management` client)

## Creating users

### Via lcp-server API (recommended)

```bash
POST /users
Authorization: Bearer <admin-token>
{ "email": "user@example.com", "firstName": "Alice", "lastName": "Smith" }
```

lcp-server proxies this to Keycloak's Admin REST API and creates the company membership record.

### Directly in Keycloak admin UI

1. Realm `lcp` → **Users → Add user**
2. Set username and email, save
3. **Credentials** tab → Set password (uncheck "Temporary")

## Connecting an external IdP

To replace Keycloak with Auth0, Okta, or another OIDC provider, set these env vars:

```
OIDC_ISSUER_URL=https://your-idp.example.com/
OIDC_CLIENT_ID=lcp-server
OIDC_CLIENT_SECRET=<your-client-secret>
```

lcp-server discovers the JWKS endpoint via `{OIDC_ISSUER_URL}/.well-known/jwks.json`. Any OIDC-compliant IdP works.
