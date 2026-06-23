// Stub for e2e tests — passport-jwt calls secretOrKeyProvider(req, rawJwtToken, done).
// Returning 'stub-secret' lets makeTestJwt() (HS256 signed with that key) pass validation.
export const passportJwtSecret =
  () =>
  (
    _req: unknown,
    _rawJwtToken: unknown,
    done: (err: null, secret: string) => void,
  ) =>
    done(null, 'stub-secret');
