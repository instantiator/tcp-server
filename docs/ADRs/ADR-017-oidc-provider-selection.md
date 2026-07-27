# ADR-017: OIDC Provider Selection

**Status:** Accepted (2026-07-17)

## Context

ADR-011 chose Keycloak as the bundled OIDC provider. It works, but it is a
Quarkus/JVM application: in `docker-compose.yml` its healthcheck carries a
comment explaining that `start_period`/`retries`/`interval` had to be widened
from 210s to 360s total headroom because Keycloak was too slow to boot under
constrained resources, and it routinely runs 512MB–1GB+ at idle. This has
contributed to long stack start-up times and degraded system performance
while it's running.

This ADR evaluates alternatives against:

- **Lightweight** — Keycloak is the baseline to beat.
- **Containerised** — must run as the bundled, optional (`--profile auth`)
  local-dev service it is today.
- **Free and OSS, permissive license.**
- **Compatible** — standards-compliant OIDC/OAuth2, no code changes to
  interact with it, ideally no special cases (footnote in the originating
  prompt: Keycloak already has at least one — see "Known Keycloak special
  cases" below).
- **Well-supported, well-maintained, well-documented.**
- **Easy to configure** — our launch scripts need to script realm/client/test
  user creation the way `scripts/start-deployment.sh` does today.
- **Low effort to switch.**
- **Nice to have:** shares the existing Postgres container rather than
  running its own database.

### Known Keycloak special cases in the codebase today

- `jwt.strategy.ts` and `auth-token.service.ts` both rebase the discovery
  doc's `jwks_uri`/`token_endpoint` onto `OIDC_INTERNAL_ISSUER_URL`, because
  Keycloak (with `KC_HOSTNAME` set) advertises its **public** hostname in the
  discovery document even when that document was fetched over the
  **internal** Docker network URL.
- Keycloak's access tokens default to `aud=account`, not the requesting
  client ID — `docs/authentication.md` documents this as needing either an
  audience mapper or leaving `OIDC_AUDIENCE` unset.
- `health.controller.ts` and the smoke/api test defaults assume a `master`
  realm exists for a cheap discovery-endpoint reachability check — a
  Keycloak-specific concept.
- Keycloak 24+ moved `/health/ready` to a separate management port (9000),
  not the main port (8080) — the compose healthcheck routes around this.

## Options considered

|                                | Keycloak (stay)                                                      | Zitadel                                                                                                                                                                       | Authentik                                                                                                                                        | Ory (Hydra+Kratos)                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Lightweight**                | Java/Quarkus, 512MB–1GB+ idle                                        | Go, single static binary, ~100MB idle                                                                                                                                         | Python/Django; server+worker, no Redis needed as of 2025.10, but still heavier than Go                                                           | Go, but two separate services (Hydra + Kratos), each with overhead                                                                |
| **License**                    | Apache 2.0                                                           | **AGPL 3.0** (core, since v3/March 2025) — not permissive                                                                                                                     | MIT                                                                                                                                              | Apache 2.0                                                                                                                        |
| **Compatible / special cases** | `aud=account` default, master-realm assumption, issuer-rebase needed | OpenID Certified; **includes client ID in `aud` by default** (no mapper needed); **does not support the ROPC grant at all** (dropped for security reasons ahead of OAuth 2.1) | Full OIDC/OAuth2/SAML/LDAP; "password" grant is documented but reported non-functional (treated like `client_credentials`, upstream issue #5860) | Fully spec-compliant OAuth2/OIDC via Hydra; identity/credentials split into a second service (Kratos), adding integration surface |
| **Maintenance**                | Very mature, huge ecosystem, RedHat/CNCF-adjacent                    | Actively developed, OpenID Certified, growing fast                                                                                                                            | Solid single-company-backed project, active community                                                                                            | Used at scale (e.g. by OpenAI); mature but modular                                                                                |
| **Config ergonomics**          | Imperative `kcadm.sh` scripting (current `start-deployment.sh`)      | `ZITADEL_FIRSTINSTANCE_*` env vars for first-boot bootstrap + REST/gRPC API for everything else                                                                               | Declarative YAML "blueprints" — closest analogue to a realm-import file                                                                          | Steepest: two services/APIs to script instead of one                                                                              |
| **Migration effort**           | None                                                                 | Moderate: compose/script rewrite is contained; the ROPC gap forces a CLI login-flow rework (see Consequences)                                                                 | Moderate, similar shape to Zitadel minus the ROPC-workaround need — but rejected below                                                           | Highest: two services, two schemas, steepest learning curve                                                                       |
| **Shares Postgres**            | Yes (own logical DB)                                                 | Yes (DSN to shared instance, own logical DB)                                                                                                                                  | Yes (own logical DB)                                                                                                                             | Yes, but two logical DBs (one per service)                                                                                        |

## Decision

**Switch to Zitadel**, running its classic embedded login (single container,
no reverse proxy) rather than the newer, separately-hosted Login V2 UI.

### Why Zitadel over staying on Keycloak

The stated pain — slow start-up and heavy resource consumption — is solved
decisively by Zitadel's single-Go-binary architecture (~100MB vs Keycloak's
512MB-1GB+), which is the biggest lever available among the criteria. It is
also OpenID Certified and includes the client ID in `aud` by default,
removing one of Keycloak's two documented special cases outright.

### Why Zitadel over Authentik

Authentik is MIT-licensed (a better fit for the "permissive license"
criterion than Zitadel's AGPL 3.0) and would have been the pick on license
grounds alone. But on inspection its password grant is reported broken in
practice (behaves like `client_credentials`, not real ROPC — same
underlying gap as Zitadel, without Zitadel's compensating resource-usage
win), so the license advantage doesn't buy back any real compatibility.
Zitadel is also markedly lighter (single Go binary vs Python/Django
server+worker) and more actively certified against the OIDC conformance
suite. On balance the resource-usage criterion — the one this evaluation was
explicitly asked to prioritise — outweighs the license difference, given
Zitadel is only ever run here as an unmodified upstream container reached
over HTTP: AGPL's copyleft obligations attach to modifications of Zitadel's
own source, not to software (lcp-server, MIT-licensed) that merely talks to
it over the network. There is no obligation for lcp-server to change its
license as a result of this choice.

### Why not Ory

Ory splits identity (Kratos) from the OAuth2/OIDC protocol layer (Hydra) —
two services, two databases, and a documented steep learning curve to wire
together correctly. That's a poor fit for "low effort to switch" and "easy
to configure" when the other options do the job as a single service.

### Classic login, not Login V2

Zitadel v4 defaults new instances to a separate, mandatory Next.js "Login
V2" container plus a recommended reverse proxy in front of both containers —
operational pieces the stack doesn't have today (Keycloak is a single
exposed HTTP port, no reverse proxy). Setting
`ZITADEL_DEFAULTINSTANCE_FEATURES_LOGINV2_REQUIRED=false` keeps the classic,
single-binary login and preserves today's shape. Classic login is on a
deprecation path for a future major Zitadel release, so this is a deliberate
short-term trade to keep this migration's scope contained — revisit before
classic login is actually removed upstream.

## Consequences

- **The ROPC-grant gap is the largest real cost of this migration.** Zitadel
  does not support the Resource Owner Password Credentials grant under any
  configuration. Today's `POST /api/auth/token` (`auth-token.service.ts` /
  `auth-token.controller.ts`), used by `lcp-cli get-token`, proxies exactly
  this grant, as does the `api` test tier's
  `ApiHelper.postCredentialsForToken()`. This requires migrating the CLI
  login flow to the **OAuth Device Authorization Grant** (RFC 8628), which
  Zitadel supports natively. This is a genuine violation of the "no code
  changes" criterion, but is arguably a net improvement regardless of
  provider choice: ROPC is deprecated in OAuth 2.1 for exposing user
  passwords directly to the client, and device-flow is the standard modern
  pattern for CLI login.
- The internal/external issuer-rebasing code in `jwt.strategy.ts` /
  `auth-token.service.ts` likely still needs to exist in some form (any
  self-hosted IdP reached via a different hostname from inside vs. outside
  Docker has this problem — it is a network-topology fact, not a
  Keycloak-only quirk), but should be re-verified against Zitadel's actual
  discovery-document behaviour and its Keycloak-specific comments/wording
  updated.
- The `aud=account` workaround and its documentation in
  `docs/authentication.md` can be removed — Zitadel includes the client ID
  in `aud` by default.
- The "master realm" assumption in `health.controller.ts` and the
  smoke/api test defaults needs generalising — Zitadel has no realm concept
  (single default instance/organisation).
- Docs referencing Keycloak (`docs/authentication.md`,
  `docs/keycloak-setup.md`, `docs/services.md`, `docs/scripts.md`,
  `docs/setup-checklist.md`, `docs/testing.md`, `docs/development.md`) need
  updating.
- No Keycloak Admin-API migration cost: ADR-011's `POST /users` /
  `PATCH /users/:id/status` Keycloak-admin-API proxy endpoints were deferred
  and never built, so there's nothing to port there.

## Alternatives considered

- **Stay on Keycloak.** Rejected: does not address the resource/start-up
  pain that motivated this review; the two documented special cases
  (`aud=account`, master-realm assumption) remain.
- **Authentik.** Rejected: better license fit (MIT), declarative
  "blueprints" config is a genuine ergonomic win, and it avoids the
  ROPC-driven CLI rework no better than Zitadel does — but it's heavier
  (Python/Django, two processes) and less certified/mature on the OIDC
  conformance front than Zitadel. See "Why Zitadel over Authentik" above.
- **Ory (Hydra + Kratos).** Rejected: two services, two databases, steepest
  operational/learning curve of the options considered, for no compensating
  win on any other criterion.
