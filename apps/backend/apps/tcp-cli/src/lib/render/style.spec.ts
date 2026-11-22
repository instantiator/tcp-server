import { ansiStyle, plainStyle } from './style';

describe('style backends', () => {
  it('plainStyle is identity for paint and escape', () => {
    expect(plainStyle.paint('response', 'hi ^ there')).toBe('hi ^ there');
    expect(plainStyle.escape('a ^ b')).toBe('a ^ b');
  });

  it('ansiStyle wraps text in the style colour and a reset, without escaping', () => {
    expect(ansiStyle.paint('reasoning', 'x')).toBe('\x1b[90mx\x1b[0m');
    expect(ansiStyle.escape('a ^ b')).toBe('a ^ b');
  });
});
