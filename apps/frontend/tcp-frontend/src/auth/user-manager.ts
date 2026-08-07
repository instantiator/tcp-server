import {
  InMemoryWebStorage,
  UserManager,
  WebStorageStateStore,
  type UserManagerSettings,
} from 'oidc-client-ts';
import { getRuntimeConfig } from '../runtime-config';

/**
 * The settings that make this a public PKCE client whose tokens never touch
 * durable storage (ADR-024). Exported separately from the manager so the
 * security-critical values can be asserted without standing one up.
 *
 * Nothing here names Zitadel. The client is plain OIDC — discovery, the
 * authorization code flow, and the standard scopes — so pointing it at another
 * provider is two environment variables and no code change. The provider
 * specifics live in `scripts/start-deployment.sh`, which only ever registers
 * against the bundled localhost instance.
 */
export const createUserManagerSettings = (): UserManagerSettings => {
  const { oidcIssuerUrl, oidcClientId, oidcLoadUserInfo } = getRuntimeConfig();

  return {
    authority: oidcIssuerUrl,
    client_id: oidcClientId,
    // Derived from the origin the app was actually loaded from, which is the
    // address start-deployment.sh registered. Configuring it separately would
    // let a non-default EXPOSE_PORT_WEB disagree with the registration, and
    // the resulting error arrives at the end of an otherwise-working sign-in
    // without naming the port.
    redirect_uri: `${window.location.origin}/callback`,
    post_logout_redirect_uri: `${window.location.origin}/`,
    // Authorization Code. oidc-client-ts applies PKCE to it unconditionally;
    // there is no hand-rolled challenge anywhere in this codebase.
    response_type: 'code',
    // `profile` and `email` are not decoration: without them 008.06's profile
    // dialog has an opaque subject identifier and nothing else to show.
    scope: 'openid profile email',
    // No `offline_access`. The client never receives a refresh token, so an
    // XSS gets at most the short-lived access token that happens to be in
    // memory when it runs — which is the entire basis of ADR-024's decision.

    // The tokens. An in-memory store is emptied by a page reload, and
    // re-authentication is a full-page redirect that costs a few hundred
    // milliseconds against a live provider session.
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    // The PKCE verifier and the `state` nonce, which must survive the
    // navigation to the provider and back and therefore cannot live in
    // memory. Neither is a token: single-use, scoped to one sign-in, and
    // worthless to an attacker who cannot also receive the callback.
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),

    // Both of these renew through a hidden iframe, which depends on the
    // provider's cookie being readable cross-origin — a third-party cookie,
    // and one browsers are removing. ADR-024 rejected the mechanism, so the
    // library must not be left to reach for it on a default.
    automaticSilentRenew: false,
    monitorSession: false,

    // The one setting here that depends on the provider rather than the
    // protocol, and therefore the one that is configured rather than decided.
    // Zitadel puts `profile` and `email` in the ID token, so the default is a
    // userinfo round trip nobody makes; a provider returning a minimal ID
    // token sets OIDC_LOAD_USER_INFO=true instead of editing this file.
    //
    // `=== true` rather than a truthiness check: a hand-written config.js
    // carrying the *string* 'false' is truthy, and the resulting behaviour is
    // the exact opposite of what was asked for.
    loadUserInfo: oidcLoadUserInfo === true,
  };
};

let manager: UserManager | undefined;

/**
 * The application's single OIDC client.
 *
 * Constructed on first use rather than at module load, because
 * {@link getRuntimeConfig} throws when `/config.js` is absent — as it is under
 * a bare `vite dev` — and an import-time throw would take the whole bundle
 * down instead of the one call that needed configuring.
 *
 * A singleton because the fetch wrapper (005.01) and the stream reader
 * (005.02) are not components and cannot read a React context, and because two
 * managers would hold two different in-memory users. When 004.02 mounts
 * `AuthProvider`, it must be given **this** instance rather than a second set
 * of settings.
 */
export const getUserManager = (): UserManager =>
  (manager ??= new UserManager(createUserManagerSettings()));
