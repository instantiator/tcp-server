import { describe, expect, it } from 'vitest';
import { t } from './strings';

describe('the strings seam', () => {
  it('resolves a known key', () => {
    expect(t('app.title')).toBe('TCP');
  });

  it('fills a placeholder from the values it is given', () => {
    expect(t('announce.routeChange', { title: 'TCP' })).toBe('TCP');
    expect(t('announce.tasksAdded', { count: 2 })).toBe('Tasks: 2 added');
  });

  it('leaves an unsupplied placeholder in place', () => {
    // Deliberate: a missing value shows up in the output rather than
    // silently producing "Loading …", which reads as though it worked.
    expect(t('state.loading')).toBe('Loading {label}…');
  });

  it('ignores values with no slot to fill', () => {
    expect(t('app.title', { unused: 'x' })).toBe('TCP');
  });

  it('rejects an unknown key at compile time', () => {
    // The seam's real guarantee: a typo is a type error rather than a blank
    // screen. `@ts-expect-error` fails the typecheck if this ever stops being
    // an error — which is how this assertion is enforced.
    // @ts-expect-error 'nope' is not a StringKey
    expect(() => t('nope')).not.toThrow();
  });
});
