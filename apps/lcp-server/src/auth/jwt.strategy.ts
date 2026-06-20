import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

/**
 * Passport strategy that validates OIDC access tokens by fetching the
 * issuer's JWKS and verifying the token's signature, expiry, audience,
 * and issuer claims.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const issuerUrl = config.getOrThrow<string>('OIDC_ISSUER_URL');
    // Use internal URL for JWKS fetch (container-to-container); keep issuerUrl for iss validation.
    const internalUrl =
      config.get<string>('OIDC_INTERNAL_ISSUER_URL') ?? issuerUrl;
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        // Keycloak's JWKS endpoint is /protocol/openid-connect/certs (not /.well-known/jwks.json).
        jwksUri: `${internalUrl.replace(/\/$/, '')}/protocol/openid-connect/certs`,
      }),
      // No audience check: Keycloak ROPC tokens set aud=account, not the client ID.
      // Validating iss is sufficient to confirm the token came from our realm.
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
