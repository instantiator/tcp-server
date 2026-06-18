// Stub for e2e tests — auth guards are not exercised in these tests.
export const passportJwtSecret = () =>
  (_req: unknown, _header: unknown, _payload: unknown, done: Function) =>
    done(null, 'stub-secret');
