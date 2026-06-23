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
 */
export function makeTestJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: 'test-user',
      aud: process.env.OIDC_CLIENT_ID ?? 'lcp-server',
      iss: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/lcp',
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = createHmac('sha256', 'stub-secret')
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}
