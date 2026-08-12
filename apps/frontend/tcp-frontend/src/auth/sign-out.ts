import { getUserManager } from './user-manager';

/**
 * Ends the session here and at the provider, and returns the user to the
 * landing page.
 *
 * `signoutRedirect()` removes the local user itself, before it builds the
 * request — so by the time a provider without an `end_session_endpoint` throws,
 * the local side is already clean and only the navigation is missing. RP-
 * initiated logout is optional in OIDC; Zitadel publishes one, so this bites
 * only an external provider, and it bites as an exception thrown out of a menu
 * item, leaving the user apparently still signed in.
 */
export const startSignOut = async (): Promise<void> => {
  const userManager = getUserManager();

  try {
    await userManager.signoutRedirect();
  } catch {
    await userManager.removeUser();
    window.location.assign('/');
  }
};
