# Zitadel Setup Guide

LCP uses an OIDC-compatible IdP for authentication. Zitadel is the default, provided as an optional Docker Compose service.

## Automated local setup

For local development, `scripts/start-dev.sh` handles everything below automatically — it starts all services, bootstraps the `lcp` org, project, and OIDC application, and creates a human and a machine test user:

```bash
./scripts/start-dev.sh                          # uses .env or .env.testing
./scripts/start-dev.sh -e .env.local            # use a custom env file
```

The rest of this guide explains what that automation does and how to verify or repeat it manually.

## How bootstrap works

Zitadel is bootstrapped automatically by `scripts/start-deployment.sh` (which `start-dev.sh`
delegates to) using a machine-user Personal Access Token (PAT):

1. On first boot, Zitadel's `ZITADEL_FIRSTINSTANCE_ORG_MACHINE_MACHINE_USERNAME` and
   `ZITADEL_FIRSTINSTANCE_PATPATH` env vars (set in `docker-compose.yml`) create a
   bootstrap machine user and write its PAT to
   `docker/zitadel-machinekey/${COMPOSE_PROJECT_NAME}/pat.txt` — a bind-mounted,
   gitignored host directory, scoped per Compose project (`lcp-dev`, `lcp-api`,
   `lcp-all`, ...) so that two projects — each with their own independently
   bootstrapped Zitadel instance, tied to their own Postgres volume — never share
   (and silently overwrite) the same PAT file. This only happens once per project, on
   first boot against fresh data; subsequent starts skip it.
2. `start-deployment.sh` waits for that PAT file to appear, then uses it to authenticate
   directly against Zitadel's REST API (no ROPC grant is needed for this, unlike the old
   `kcadm.sh`-based Keycloak bootstrap) and creates, idempotently:
   - a project named `lcp`
   - an OIDC "web" application named `lcp-server`, with grant types
     `OIDC_GRANT_TYPE_DEVICE_CODE` and `OIDC_GRANT_TYPE_REFRESH_TOKEN`, and
     `accessTokenType: OIDC_TOKEN_TYPE_JWT`
   - a human test user, from `TEST_USERNAME`/`TEST_PASSWORD` in the env file
     (default `test`/`test`)
   - a machine test user named `test-machine`, with `accessTokenType:
ACCESS_TOKEN_TYPE_JWT`, used by the `api` test tier via the `client_credentials`
     grant
3. Unlike Keycloak, Zitadel generates client secrets server-side — they can't be
   pre-set, and can only be read at generation time. So on **every** run the script
   (re)generates the `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` (for the `lcp-server` app) and
   `TEST_CLIENT_ID`/`TEST_CLIENT_SECRET` (for the `test-machine` user) and writes them to the
   gitignored `<env-file>.local` override (e.g. `.env.testing.local`) — never the committed
   base file — before starting lcp-server and its dependents. Regenerating every run —
   rather than trusting whatever's in the file — is what keeps the credentials and Zitadel
   from silently drifting apart: a wiped-and-rebootstrapped Zitadel (or an env file
   bootstrapped against a different instance) otherwise leaves a stale secret that fails auth
   with an opaque `invalid_client`. See [ADR-018 §7](ADRs/ADR-018-system-configuration-setup-wizard.md)
   for the committed-vs-`.local` split.

Setting `accessTokenType` explicitly on both the app and the machine user matters:
Zitadel issues opaque/JWE-encrypted access tokens by default, which lcp-server's
JWKS-based verification can't parse at all. See
[docs/authentication.md](authentication.md#how-it-works) for more on this.

Safe to re-run — existing Zitadel resources are left untouched on subsequent starts.

## Manual verification

Open the Zitadel admin console:

```
http://localhost:8080/ui/console
```

Log in as the org admin human user — username `admin`, password from
`ZITADEL_ADMIN_PASSWORD` in your env file. From there you can inspect the `lcp` org, the
`lcp` project, the `lcp-server` application, and the test users created by bootstrap.

## Creating users

Additional human users can be created in the admin console (org → **Users** → **Add
human user**) or via the same Zitadel REST API `start-deployment.sh` uses (see
`/v2/users/new` in `scripts/start-deployment.sh` for a working example). lcp-server does
not proxy user creation to the IdP itself — there is no `/users` API on lcp-server for
this.

## Connecting an external IdP

To replace Zitadel with Auth0, Okta, or another OIDC provider, set the issuer URL
in your committed env file and put the provider-issued client credentials in the
gitignored `<env-file>.local` override (do not commit them):

```bash
# .env.<instance>            (committed)
OIDC_ISSUER_URL=https://your-idp.example.com/

# .env.<instance>.local      (gitignored)
OIDC_CLIENT_ID=lcp-server
OIDC_CLIENT_SECRET=<your-client-secret>
```

Run without `ZITADEL_ADMIN_PASSWORD` set so no local Zitadel is bootstrapped; the
deployment then requires `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` to be present.

lcp-server discovers the JWKS endpoint via the provider's discovery document
(`{OIDC_ISSUER_URL}/.well-known/openid-configuration`), reading its `jwks_uri` field —
for Zitadel that resolves to `/oauth/v2/keys`. Any OIDC-compliant IdP that publishes a
standards-compliant discovery document works without further configuration.
