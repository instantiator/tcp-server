import { isBlankText } from './format';

describe('isBlankText', () => {
  it('is true for empty and whitespace-only text', () => {
    expect(isBlankText('')).toBe(true);
    expect(isBlankText('   \n\t')).toBe(true);
  });

  it('is false for non-blank text', () => {
    expect(isBlankText('hello')).toBe(false);
  });
});
