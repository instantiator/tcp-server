import { getUserManager } from './user-manager';

/**
 * The access token to present on the next request, or `null` when there is
 * none to present.
 *
 * **Call this at the moment the token is needed and do not keep the result.**
 * A caller that reads it once and holds it keeps presenting the same string
 * after the user has signed in again — for a request that is a puzzling 401,
 * and for an event stream that reconnects every few minutes it is hours of
 * them (ADR-024).
 *
 * An expired user yields `null` rather than the dead token it still holds:
 * sending one produces a 401 the caller has to interpret, where `null` is a
 * fact it can act on directly.
 */
export const getAccessToken = async (): Promise<string | null> => {
  const user = await getUserManager().getUser();
  return user !== null && !user.expired ? user.access_token : null;
};
