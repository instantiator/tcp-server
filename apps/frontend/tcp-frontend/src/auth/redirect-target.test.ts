import { describe, expect, it } from 'vitest';
import { DEFAULT_SIGNED_IN_PATH, safeRedirectTarget } from './redirect-target';

describe('safeRedirectTarget', () => {
  describe('destinations it honours', () => {
    it.each([
      ['/companies', '/companies'],
      ['/company/acme', '/company/acme'],
      // The shape `handleUnauthorized()` saves — `pathname + search`. A
      // validator matching bare route paths would drop the query string and
      // return the user to an unfiltered view of the page they were on.
      ['/company/acme?tab=activity', '/company/acme?tab=activity'],
    ])('returns %s', (from, expected) => {
      expect(safeRedirectTarget({ from })).toBe(expected);
    });
  });

  describe('destinations it refuses', () => {
    it.each([
      // Off-origin, in every spelling that reaches the address bar. The
      // backslash and the leading-tab forms are the ones a `startsWith('/')`
      // check waves through: the URL parser folds both into `//evil.example`.
      ['an absolute URL elsewhere', 'https://evil.example/companies'],
      ['a protocol-relative URL', '//evil.example'],
      ['a backslash-folded URL', '/\\evil.example'],
      ['a whitespace-prefixed URL', '\t/\\/evil.example'],
      ['credentials hiding the real host', 'https://x@evil.example/companies'],
      ['a javascript: URL', 'javascript:alert(1)'],
      // On-origin, but not somewhere a signed-in user should be sent. Both of
      // these are the redirect loop: sign in, arrive, be asked to sign in.
      ['the landing page', '/'],
      ['the callback route itself', '/callback'],
      // On-origin and undeclared: the catch-all would match it, which is why
      // the allow-list is the named routes and not the route table.
      ['an unknown path', '/nothing-here'],
      ['a path that only looks guarded', '/companies-elsewhere'],
    ])('falls back to the default for %s', (_case, from) => {
      expect(safeRedirectTarget({ from })).toBe(DEFAULT_SIGNED_IN_PATH);
    });

    it.each([
      ['a number', { from: 42 }],
      ['an object', { from: { toString: () => '/companies' } }],
      ['a missing key', {}],
      ['a bare string, not a state object', '/companies'],
      ['undefined', undefined],
      ['null', null],
    ])('falls back to the default for %s', (_case, state) => {
      expect(safeRedirectTarget(state)).toBe(DEFAULT_SIGNED_IN_PATH);
    });
  });
});
