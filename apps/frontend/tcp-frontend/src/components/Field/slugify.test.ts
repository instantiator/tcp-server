import { describe, expect, it } from 'vitest';
import { slugify } from './slugify';

describe('slugify', () => {
  it.each([
    ['Acme Corp', 'acme-corp'],
    ['  Bob’s Bikes & Repairs!  ', 'bob-s-bikes-repairs'],
    ['--x--', 'x'],
    ['', ''],
  ])('turns %j into %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});
