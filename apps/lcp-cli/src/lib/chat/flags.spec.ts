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

  it('rejects --query without a role', () => {
    expect(validateChatFlags({ companyId: 'c1', query: 'hi' }, true)).toMatch(
      /--query requires a role/,
    );
  });

  it('accepts --query with --role-id', () => {
    expect(validateChatFlags({ roleId: 'r1', query: 'hi' }, true)).toBeNull();
  });

  it('accepts --role-slug scoped by --company-id', () => {
    expect(
      validateChatFlags({ roleSlug: 'analyst', companyId: 'c1' }, true),
    ).toBeNull();
  });

  it('accepts --role-slug scoped by --company-slug', () => {
    expect(
      validateChatFlags({ roleSlug: 'analyst', companySlug: 'acme' }, true),
    ).toBeNull();
  });

  it('rejects --role-slug without a company', () => {
    expect(validateChatFlags({ roleSlug: 'analyst' }, true)).toMatch(
      /requires --company/,
    );
  });

  it('rejects --role-id combined with --role-slug', () => {
    expect(
      validateChatFlags({ roleId: 'r1', roleSlug: 'analyst' }, true),
    ).toMatch(/pass only one of --role/);
  });

  it('rejects --company-id combined with --company-slug', () => {
    expect(
      validateChatFlags({ companyId: 'c1', companySlug: 'acme' }, true),
    ).toMatch(/pass only one of --company/);
  });

  it('rejects --role-id combined with a company flag (role-id already implies its company)', () => {
    expect(
      validateChatFlags({ roleId: 'r1', companySlug: 'acme' }, true),
    ).toMatch(/not both/);
  });

  it('accepts --company-slug alone only when the TUI is available', () => {
    expect(validateChatFlags({ companySlug: 'acme' }, true)).toBeNull();
    expect(validateChatFlags({ companySlug: 'acme' }, false)).toMatch(
      /requires? a tty|full-screen tui/i,
    );
  });

  it('accepts a combined --role given as a UUID, TUI or not', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(validateChatFlags({ role: uuid }, true)).toBeNull();
    expect(validateChatFlags({ role: uuid }, false)).toBeNull();
  });

  it('accepts a combined --role slug scoped by a combined --company', () => {
    expect(
      validateChatFlags({ role: 'analyst', company: 'acme' }, true),
    ).toBeNull();
  });

  it('rejects a combined --role slug without a company', () => {
    expect(validateChatFlags({ role: 'analyst' }, true)).toMatch(
      /requires --company/,
    );
  });

  it('rejects a combined --role UUID combined with a company (redundant)', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(validateChatFlags({ role: uuid, company: 'acme' }, true)).toMatch(
      /not both/,
    );
  });

  it('rejects --role combined with --role-id', () => {
    expect(validateChatFlags({ role: 'r1', roleId: 'r1' }, true)).toMatch(
      /pass only one of --role/,
    );
  });

  it('rejects --company combined with --company-slug', () => {
    expect(
      validateChatFlags({ company: 'acme', companySlug: 'acme' }, true),
    ).toMatch(/pass only one of --company/);
  });

  it('accepts --query with a combined --role UUID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(validateChatFlags({ role: uuid, query: 'hi' }, true)).toBeNull();
  });
});
