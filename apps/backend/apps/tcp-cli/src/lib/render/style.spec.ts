import { ansiStyle, markupStyle, plainStyle } from './style';

describe('style backends', () => {
  it('plainStyle is identity for paint and escape', () => {
    expect(plainStyle.paint('response', 'hi ^ there')).toBe('hi ^ there');
    expect(plainStyle.escape('a ^ b')).toBe('a ^ b');
  });

  it('ansiStyle wraps text in the style colour and a reset, without escaping', () => {
    expect(ansiStyle.paint('reasoning', 'x')).toBe('\x1b[90mx\x1b[0m');
    expect(ansiStyle.escape('a ^ b')).toBe('a ^ b');
  });

  it('markupStyle wraps text in caret codes and escapes literal carets', () => {
    expect(markupStyle.paint('state', 'x')).toBe('^Cx^:');
    // The default-foreground response style adds no code.
    expect(markupStyle.paint('response', 'x')).toBe('x');
    expect(markupStyle.escape('a ^ b')).toBe('a ^^ b');
  });
});
