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
  it('accepts --role-id alone', () => {
    expect(validateChatFlags({ roleId: 'r1' })).toBeNull();
  });

  it('rejects --company-id alone with no role — chat always requires one', () => {
    expect(validateChatFlags({ companyId: 'c1' })).toMatch(
      /chat requires a role.*tui <company>/i,
    );
  });

  it('rejects --company-slug alone with no role — chat always requires one', () => {
    expect(validateChatFlags({ companySlug: 'acme' })).toMatch(
      /chat requires a role.*tui <company>/i,
    );
  });

  it('rejects neither flag being given', () => {
    expect(validateChatFlags({})).toMatch(/role-id|company-id/);
  });

  it('rejects both --role-id and --company-id together', () => {
    expect(validateChatFlags({ roleId: 'r1', companyId: 'c1' })).toMatch(
      /not both/,
    );
  });

  it('rejects --query without a role', () => {
    expect(validateChatFlags({ companyId: 'c1', query: 'hi' })).toMatch(
      /--query requires a role/,
    );
  });

  it('accepts --query with --role-id', () => {
    expect(validateChatFlags({ roleId: 'r1', query: 'hi' })).toBeNull();
  });

  it('accepts --role-slug scoped by --company-id', () => {
    expect(
      validateChatFlags({ roleSlug: 'analyst', companyId: 'c1' }),
    ).toBeNull();
  });

  it('accepts --role-slug scoped by --company-slug', () => {
    expect(
      validateChatFlags({ roleSlug: 'analyst', companySlug: 'acme' }),
    ).toBeNull();
  });

  it('rejects --role-slug without a company', () => {
    expect(validateChatFlags({ roleSlug: 'analyst' })).toMatch(
      /requires --company/,
    );
  });

  it('rejects --role-id combined with --role-slug', () => {
    expect(validateChatFlags({ roleId: 'r1', roleSlug: 'analyst' })).toMatch(
      /pass only one of --role/,
    );
  });

  it('rejects --company-id combined with --company-slug', () => {
    expect(validateChatFlags({ companyId: 'c1', companySlug: 'acme' })).toMatch(
      /pass only one of --company/,
    );
  });

  it('rejects --role-id combined with a company flag (role-id already implies its company)', () => {
    expect(validateChatFlags({ roleId: 'r1', companySlug: 'acme' })).toMatch(
      /not both/,
    );
  });

  it('accepts a combined --role given as a UUID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(validateChatFlags({ role: uuid })).toBeNull();
  });

  it('accepts a combined --role slug scoped by a combined --company', () => {
    expect(validateChatFlags({ role: 'analyst', company: 'acme' })).toBeNull();
  });

  it('rejects a combined --role slug without a company', () => {
    expect(validateChatFlags({ role: 'analyst' })).toMatch(
      /requires --company/,
    );
  });

  it('rejects a combined --role UUID combined with a company (redundant)', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(validateChatFlags({ role: uuid, company: 'acme' })).toMatch(
      /not both/,
    );
  });

  it('rejects --role combined with --role-id', () => {
    expect(validateChatFlags({ role: 'r1', roleId: 'r1' })).toMatch(
      /pass only one of --role/,
    );
  });

  it('rejects --company combined with --company-slug', () => {
    expect(validateChatFlags({ company: 'acme', companySlug: 'acme' })).toMatch(
      /pass only one of --company/,
    );
  });

  it('accepts --query with a combined --role UUID', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(validateChatFlags({ role: uuid, query: 'hi' })).toBeNull();
  });
});
