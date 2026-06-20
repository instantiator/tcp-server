import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

/**
 * Passport strategy that validates OIDC access tokens by fetching the
 * issuer's JWKS and verifying the token's signature, expiry, and issuer
 * claims. Audience validation is enabled when `OIDC_AUDIENCE` is set.
 *
 * Not instantiated directly — {@link AuthModule} uses an async factory to
 * resolve `jwksUri` from the provider's discovery document before constructing
 * this class, making it compatible with any standards-compliant OIDC provider.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  /**
   * @param config - NestJS config service
   * @param jwksUri - JWKS endpoint resolved from the provider's discovery doc
   * @param audience - Optional audience claim to validate (from `OIDC_AUDIENCE`)
   */
  constructor(config: ConfigService, jwksUri: string, audience?: string) {
    const issuerUrl = config.getOrThrow<string>('OIDC_ISSUER_URL');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri,
      }),
      // Audience validation is opt-in: set OIDC_AUDIENCE if your provider
      // populates aud with a known value (e.g. an API identifier on Auth0/Okta).
      // Keycloak ROPC tokens set aud=account by default; leave OIDC_AUDIENCE
      // unset or configure a Keycloak audience mapper to override this.
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
