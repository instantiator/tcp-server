import { describe, expect, it } from 'vitest';
import { dim } from './palette';

const channels = (colour: number): [number, number, number] => [
  (colour >> 16) & 0xff,
  (colour >> 8) & 0xff,
  colour & 0xff,
];

describe('dim', () => {
  it('mixes about 45% of the way towards the dark tone, channel by channel', () => {
    // 0xffffff towards 0x2a2d3a: 255 - 0.45 * (255 - [42, 45, 58]), rounded.
    expect(channels(dim(0xffffff))).toEqual([159, 161, 166]);
  });

  it('darkens a pale colour and lightens a darker one only towards the tone', () => {
    const [r, g, b] = channels(dim(0xd6e2ea));
    const [r0, g0, b0] = channels(0xd6e2ea);
    expect(r).toBeLessThan(r0);
    expect(g).toBeLessThan(g0);
    expect(b).toBeLessThan(b0);
  });

  it('leaves the tone itself unchanged', () => {
    expect(dim(0x2a2d3a)).toBe(0x2a2d3a);
  });
});
