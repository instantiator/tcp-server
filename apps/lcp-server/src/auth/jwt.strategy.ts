import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const issuerUrl = config.getOrThrow<string>('OIDC_ISSUER_URL');
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: `${issuerUrl}/.well-known/jwks.json`,
      }),
      audience: config.getOrThrow<string>('OIDC_CLIENT_ID'),
      issuer: issuerUrl,
    });
  }

  validate(payload: Record<string, unknown>): Record<string, unknown> {
    return payload;
  }
}
