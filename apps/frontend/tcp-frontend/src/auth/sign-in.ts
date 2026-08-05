/**
 * Starts the sign-in journey.
 *
 * A placeholder until 004.02, which replaces this body with the real OIDC
 * redirect (ADR-024). It exists as its own module so that arrival changes one
 * function, not the landing page and not its tests — and so a test can assert
 * that the control *starts sign-in*, rather than only that a button is there.
 */
export const startSignIn = (): void => {
  console.info('Sign-in is not wired up until 004.02.');
};
