/**
 * Ends the session and returns the user to the landing page.
 *
 * A placeholder until 004.03, which replaces this body with the real
 * end-session flow — clearing the in-memory session *and* ending it at the
 * provider (ADR-024). It exists as its own module for the same reason
 * `startSignIn` does: that arrival changes one function, not the header and
 * not its tests, and a test can assert the menu item *starts sign-out* rather
 * than only that it is there.
 *
 * Deliberately inert rather than logging a placeholder: `Header.test.tsx`
 * already proves the menu item reaches this function by keyboard, so a
 * `console.info` here would prove nothing further and reads to the slop scanner
 * as a leftover — which it would eventually become.
 */
export const startSignOut = (): void => {
  // Intentionally empty: there is no session to end until 004.03 creates one.
};
