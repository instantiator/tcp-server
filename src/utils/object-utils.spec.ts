import { defined, isUUID } from './ObjectUtils';

describe('defined', () => {
  it('returns true for a non-null string', () => {
    expect(defined('hello')).toBe(true);
  });

  it('returns true for 0', () => {
    expect(defined(0)).toBe(true);
  });

  it('returns true for false', () => {
    expect(defined(false)).toBe(true);
  });

  it('returns true for an empty string', () => {
    expect(defined('')).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(defined(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(defined(null)).toBe(false);
  });
});

describe('isUUID', () => {
  const validUUID = '550e8400-e29b-41d4-a716-446655440000';

  it('returns true for a valid lowercase UUID', () => {
    expect(isUUID(validUUID)).toBe(true);
  });

  it('returns true for an uppercase UUID', () => {
    expect(isUUID(validUUID.toUpperCase())).toBe(true);
  });

  it('returns true for a mixed-case UUID', () => {
    expect(isUUID('550E8400-e29b-41D4-a716-446655440000')).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(isUUID('')).toBe(false);
  });

  it('returns false when a segment has the wrong length', () => {
    expect(isUUID('550e8400-e29b-41d4-a716-44665544000')).toBe(false);
  });

  it('returns false for a string with no hyphens', () => {
    expect(isUUID('550e8400e29b41d4a716446655440000')).toBe(false);
  });

  it('returns false when a segment contains non-hex characters', () => {
    expect(isUUID('gggggggg-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('returns false for a UUID with trailing characters', () => {
    expect(isUUID(`${validUUID}x`)).toBe(false);
  });
});
