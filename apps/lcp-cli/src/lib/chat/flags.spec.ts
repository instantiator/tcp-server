import { shouldUseTui, validateChatFlags } from './flags';

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

describe('validateChatFlags', () => {
  it('accepts --role-id alone, TUI or not', () => {
    expect(validateChatFlags({ roleId: 'r1' }, true)).toBeNull();
    expect(validateChatFlags({ roleId: 'r1' }, false)).toBeNull();
  });

  it('accepts --company-id alone only when the TUI is available', () => {
    expect(validateChatFlags({ companyId: 'c1' }, true)).toBeNull();
    expect(validateChatFlags({ companyId: 'c1' }, false)).toMatch(
      /requires? a tty|full-screen tui/i,
    );
  });

  it('rejects neither flag being given', () => {
    expect(validateChatFlags({}, true)).toMatch(/role-id|company-id/);
  });

  it('rejects both --role-id and --company-id together', () => {
    expect(validateChatFlags({ roleId: 'r1', companyId: 'c1' }, true)).toMatch(
      /not both/,
    );
  });

  it('rejects --query without --role-id', () => {
    expect(validateChatFlags({ companyId: 'c1', query: 'hi' }, true)).toMatch(
      /--query requires --role-id/,
    );
  });

  it('accepts --query with --role-id', () => {
    expect(validateChatFlags({ roleId: 'r1', query: 'hi' }, true)).toBeNull();
  });
});
