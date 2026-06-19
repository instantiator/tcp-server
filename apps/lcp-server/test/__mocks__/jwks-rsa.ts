// Stub for e2e tests — auth guards are not exercised in these tests.
export const passportJwtSecret =
  () =>
  (
    _req: unknown,
    _header: unknown,
    _payload: unknown,
    done: (err: null, secret: string) => void,
  ) =>
    done(null, 'stub-secret');
