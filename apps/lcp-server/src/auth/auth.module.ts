import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './jwt.strategy';

/**
 * Resolves the provider's JWKS URI from its OIDC discovery document.
 *
 * Uses the internal issuer URL for the HTTP fetch (so it works from inside
 * Docker), then rebases the returned `jwks_uri` back onto the internal host in
 * case the provider advertises its public hostname in the discovery doc
 * (e.g. Keycloak with `KC_HOSTNAME` set).
 */
async function resolveJwksUri(internalIssuer: string): Promise<string> {
  const discoveryUrl = `${internalIssuer}/.well-known/openid-configuration`;
  const res = await fetch(discoveryUrl);
  if (!res.ok) {
    throw new Error(
      `OIDC discovery failed (HTTP ${res.status}) from ${discoveryUrl}. ` +
        `Check OIDC_ISSUER_URL and OIDC_INTERNAL_ISSUER_URL.`,
    );
  }
  const doc = (await res.json()) as { issuer: string; jwks_uri: string };

  // Rebase jwks_uri: if the provider's advertised issuer differs from the
  // internal URL we used to fetch the doc, replace the prefix so all JWKS
  // requests stay on the internal network.
  const advertisedBase = doc.issuer.replace(/\/$/, '');
  const internalBase = internalIssuer.replace(/\/$/, '');
  return doc.jwks_uri.startsWith(advertisedBase)
    ? internalBase + doc.jwks_uri.slice(advertisedBase.length)
    : doc.jwks_uri;
}

/**
 * Wires Passport with the JWT strategy so that {@link JwtAuthGuard} can be
 * applied to any route that requires authentication.
 *
 * Uses an async factory so the JWKS URI is discovered from the provider's
 * discovery document at startup — compatible with any OIDC provider, not just
 * Keycloak.
 */
@Module({
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
  providers: [
    {
      provide: JwtStrategy,
      useFactory: async (config: ConfigService): Promise<JwtStrategy> => {
        const publicIssuer = config
          .getOrThrow<string>('OIDC_ISSUER_URL')
          .replace(/\/$/, '');
        const internalIssuer = (
          config.get<string>('OIDC_INTERNAL_ISSUER_URL') ?? publicIssuer
        ).replace(/\/$/, '');

        const jwksUri =
          config.get<string>('OIDC_JWKS_URI') ??
          (await resolveJwksUri(internalIssuer));

        const audience = config.get<string>('OIDC_AUDIENCE');
        return new JwtStrategy(config, jwksUri, audience);
      },
      inject: [ConfigService],
    },
  ],
  exports: [PassportModule],
})
export class AuthModule {}
