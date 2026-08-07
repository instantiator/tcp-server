// Proves that scripts/start-deployment.sh's Zitadel bootstrap registered
// tcp-web's browser client correctly, without a sign-in journey — there is no
// callback route to land on until 004.02. The gap this closes is real: the
// bootstrap creates TWO OIDC applications (start-deployment.sh), a
// confidential `tcp-server` client for the API and a public PKCE `tcp-web`
// client for the browser, and it is entirely possible to wire config.js to
// the wrong one, or to register the right client with the wrong redirect URI.
// Either mistake leaves the app looking fine right up until sign-in, at which
// point Zitadel's error names neither the client nor the redirect URI it
// rejected.
//
// The check: read the issuer and client ID the deployment actually serves out
// of window.__TCP_CONFIG__, then send Zitadel an authorize request for that
// client with a redirect_uri matching this deployment's own origin — the same
// request a real sign-in would open a browser tab to, short of following it
// anywhere. A registered public client accepts it and redirects to Zitadel's
// login UI. An unregistered redirect URI, or a client ID belonging to the
// confidential `tcp-server` app (which only knows about
// http://localhost:3000/auth/callback — the previous, broken configuration),
// both come back as an error instead.
import { expect, test } from '@playwright/test';

test.describe('browser OIDC registration', () => {
  test('Zitadel accepts a PKCE authorize request for the client config.js serves', async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto('/');
    const config = await page.evaluate(
      () =>
        (
          window as unknown as {
            __TCP_CONFIG__: { oidcIssuerUrl: string; oidcClientId: string };
          }
        ).__TCP_CONFIG__,
    );

    const params = new URLSearchParams({
      client_id: config.oidcClientId,
      redirect_uri: `${baseURL ?? ''}/callback`,
      response_type: 'code',
      scope: 'openid profile email',
      state: 'registration-probe',
      // 43 characters of unreserved ASCII — a well-formed S256 challenge. Only
      // its shape matters; nothing here completes the exchange.
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    });

    // maxRedirects: 0 is the point — a followed redirect would land on
    // Zitadel's login page with a 200, which looks identical whether the
    // client was accepted or Zitadel is rendering its own error page there.
    // Reading the raw response is what tells the two apart.
    const response = await request.get(
      `${config.oidcIssuerUrl}/oauth/v2/authorize?${params.toString()}`,
      { maxRedirects: 0 },
    );

    expect(response.status()).toBe(302);
    const location = response.headers()['location'] ?? '';
    // The discriminating assertion. Zitadel answers a rejected client or an
    // unregistered redirect_uri with a redirect of its own — still a
    // redirect, still often a 3xx — but to an error page whose target carries
    // `error=`. Status code alone cannot tell a successful handoff to the
    // login UI apart from a same-shaped rejection.
    expect(location).not.toContain('error=');
    // A successful handoff is same-origin (Zitadel redirecting to its own
    // /login route), never a scheme-qualified URL pointing back out.
    expect(location.startsWith('/')).toBe(true);
  });
});
