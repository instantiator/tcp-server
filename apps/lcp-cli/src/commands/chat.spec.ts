import { shouldUseTui } from './chat';

describe('shouldUseTui', () => {
  it('uses the TUI on a TTY with no flags', () => {
    expect(shouldUseTui({}, true)).toBe(true);
  });

  it('falls back to the plain renderer when stdout is not a TTY', () => {
    expect(shouldUseTui({}, false)).toBe(false);
  });

  it('falls back to the plain renderer when --no-tui is passed, even on a TTY', () => {
    expect(shouldUseTui({ tui: false }, true)).toBe(false);
  });

  it('stays off when both --no-tui is passed and stdout is not a TTY', () => {
    expect(shouldUseTui({ tui: false }, false)).toBe(false);
  });
});
