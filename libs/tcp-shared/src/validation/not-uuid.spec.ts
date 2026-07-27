import { UUID_RE } from './not-uuid';

describe('UUID_RE', () => {
  it('matches a canonical UUID case-insensitively', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(UUID_RE.test(uuid)).toBe(true);
    expect(UUID_RE.test(uuid.toUpperCase())).toBe(true);
  });

  it('rejects a slug', () => {
    expect(UUID_RE.test('acme')).toBe(false);
  });

  it('rejects a slug that merely contains a UUID as a substring', () => {
    expect(UUID_RE.test('11111111-2222-3333-4444-555555555555-suffix')).toBe(
      false,
    );
  });
});
