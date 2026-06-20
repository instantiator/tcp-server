import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

/** Subset of the OIDC discovery document used to locate the JWKS endpoint. */
interface OidcDiscovery {
  issuer: string;
  jwks_uri: string;
}

async function discoverJwksUri(internalIssuer: string): Promise<string> {
  const discoveryUrl = `${internalIssuer}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed (HTTP ${res.status}) from ${discoveryUrl}` +
        ` — provider may not be ready yet`,
    );
  }
  const doc = (await res.json()) as OidcDiscovery;
  // Rebase jwks_uri onto the internal issuer — needed when the provider
  // advertises its public hostname in the discovery doc even when fetched
  // via an internal Docker network URL (e.g. Keycloak with KC_HOSTNAME set).
  const advertisedBase = doc.issuer.replace(/\/$/, '');
  const internalBase = internalIssuer.replace(/\/$/, '');
  return doc.jwks_uri.startsWith(advertisedBase)
    ? internalBase + doc.jwks_uri.slice(advertisedBase.length)
    : doc.jwks_uri;
}

/**
 * Passport strategy that validates OIDC access tokens by fetching the
 * issuer's JWKS and verifying the token's signature, expiry, and issuer
 * claims. Audience validation is enabled when `OIDC_AUDIENCE` is set.
 *
 * JWKS URI discovery is lazy: the provider's discovery document is fetched
 * on the first token validation attempt, not at startup. This means lcp-server
 * can boot before the OIDC provider is ready (common in Docker Compose where
 * Keycloak and lcp-server start simultaneously). If discovery fails, the
 * promise is cleared so the next request retries automatically.
 *
 * Compatible with any OIDC provider that publishes `jwks_uri` in its
 * discovery document. Set `OIDC_JWKS_URI` to skip discovery entirely.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const issuerUrl = config.getOrThrow<string>('OIDC_ISSUER_URL');
    const internalIssuer = (
      config.get<string>('OIDC_INTERNAL_ISSUER_URL') ?? issuerUrl
    ).replace(/\/$/, '');
    const explicitJwksUri = config.get<string>('OIDC_JWKS_URI');
    const audience = config.get<string>('OIDC_AUDIENCE');

    // Lazy, cached discovery. Cleared on failure so the next request retries.
    let jwksUriPromise: Promise<string> | null = null;
    let secretProvider: ReturnType<typeof passportJwtSecret> | null = null;

    const getSecretProvider = async () => {
      if (!secretProvider) {
        if (!jwksUriPromise) {
          jwksUriPromise = explicitJwksUri
            ? Promise.resolve(explicitJwksUri)
            : discoverJwksUri(internalIssuer);
        }
        try {
          const uri = await jwksUriPromise;
          secretProvider = passportJwtSecret({
            cache: true,
            rateLimit: true,
            jwksRequestsPerMinute: 5,
            jwksUri: uri,
          });
        } catch (e) {
          jwksUriPromise = null; // allow retry on next request
          throw e;
        }
      }
      return secretProvider;
    };

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: (req, rawToken, done) => {
        void getSecretProvider()
          .then((provider) => {
            provider(req, rawToken, done);
          })
          .catch((e: Error) => done(e));
      },
      // Audience validation is opt-in: set OIDC_AUDIENCE if your provider
      // populates aud with a known value (e.g. an API identifier on Auth0/Okta).
      // Keycloak ROPC tokens set aud=account by default; leave OIDC_AUDIENCE
      // unset or configure a Keycloak audience mapper to add a custom audience.
      ...(audience !== undefined ? { audience } : {}),
      issuer: issuerUrl,
    });
  }

  /**
   * Called after the JWT signature, expiry, audience, and issuer have been
   * verified by the strategy. The return value becomes {@link Request#user}.
   * Enrich with a DB lookup (by `payload.sub`) and a typed User shape when
   * endpoints are guarded.
   */
  validate(payload: Record<string, unknown>): Record<string, unknown> {
    return payload;
  }
}
