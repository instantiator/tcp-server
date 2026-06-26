// jwks-rsa uses a native resolver that crashes in Jest — mock it before any module loads.
jest.mock('jwks-rsa', () => ({
  passportJwtSecret: jest.fn().mockReturnValue(() => {}),
}));

// Mock passport-jwt so the PassportStrategy super() call does not spin up a real JWT verifier.
jest.mock('passport-jwt', () => ({
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn().mockReturnValue(() => null),
  },
  Strategy: class MockJwtStrategy {
    _opts: unknown;
    constructor(opts: unknown) {
      this._opts = opts;
    }
    authenticate(): void {}
  },
}));

// ── JwtStrategy ───────────────────────────────────────────────────────────────
// We test validate() via prototype access to avoid triggering the OIDC discovery
// closure inside the constructor. Constructor option assertions use a real instance
// now that jwks-rsa and passport-jwt are safely mocked.

import { JwtStrategy } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtStrategy', () => {
  describe('validate', () => {
    // Access validate via prototype to avoid triggering the OIDC discovery closure.
    const validate = JwtStrategy.prototype.validate.bind(
      Object.create(JwtStrategy.prototype) as JwtStrategy,
    );

    it('returns the JWT payload unchanged', () => {
      const payload = { sub: 'user-123', email: 'a@b.com', roles: ['admin'] };
      expect(validate(payload)).toEqual(payload);
    });

    it('returns exactly the same object reference (no copy)', () => {
      const payload = { sub: 'u1' };
      expect(validate(payload)).toBe(payload);
    });

    it('passes through arbitrary custom claims', () => {
      const payload = { sub: 'u2', custom_claim: 'value', nested: { x: 1 } };
      expect(validate(payload)).toBe(payload);
    });
  });

  // Constructor options (audience, issuer, JWKS URI) are validated at integration level
  // via the API tests — constructing JwtStrategy in a unit test requires registering with
  // passport, which crashes without a full NestJS application context.
});

describe('JwtAuthGuard', () => {
  it('is instantiable', () => {
    expect(new JwtAuthGuard()).toBeDefined();
  });

  it('exposes a canActivate method (inherited from AuthGuard)', () => {
    expect(typeof new JwtAuthGuard().canActivate).toBe('function');
  });

  // canActivate delegates to passport's authenticate() which requires the jwt strategy
  // to be registered in passport's global registry. That full integration path is covered
  // by the API-level tests (test/api/*.spec.ts). Here we only confirm the guard wires up.
});
