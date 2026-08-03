import { describe, expect, it } from 'vitest';
import { t } from './strings';

describe('the strings seam', () => {
  it('resolves a known key', () => {
    expect(t('app.title')).toBe('TCP');
  });

  it('rejects an unknown key at compile time', () => {
    // The seam's real guarantee: a typo is a type error rather than a blank
    // screen. `@ts-expect-error` fails the typecheck if this ever stops being
    // an error — which is how this assertion is enforced.
    // @ts-expect-error 'nope' is not a StringKey
    expect(() => t('nope')).not.toThrow();
  });
});
