import { createHmac } from 'node:crypto';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

/**
 * Returns a signed HS256 JWT accepted by {@link JwtStrategy} in e2e tests.
 *
 * Works because the jwks-rsa mock in `__mocks__/jwks-rsa.ts` returns
 * `'stub-secret'` as the signing key, so `passport-jwt` verifies against
 * the same HMAC-SHA256 secret we sign with here.
 *
 * @param claims overrides merged over the defaults — `sub` and `email` are
 *   the ones membership scoping keys on, so a test needing a second identity
 *   (or an email-keyed one) passes them here.
 */
export function makeTestJwt(claims: Record<string, string> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: 'test-user',
      aud: process.env.OIDC_CLIENT_ID ?? 'tcp-server',
      iss: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/tcp',
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const sig = createHmac('sha256', 'stub-secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}
