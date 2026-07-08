import type { LcpCompany, LcpRole } from '@lcp/shared';
import {
  computeCompanyWarnings,
  computeRoleWarnings,
} from './validation-warnings';

const baseRole = {
  knowledgeDomains: ['finance'],
  rolePrompt: 'You are a careful analyst.',
} as LcpRole;

const baseCompany = {
  companyContext: 'We build widgets.',
} as LcpCompany;

describe('computeRoleWarnings', () => {
  it('returns no warnings when knowledgeDomains and rolePrompt are both set', () => {
    expect(computeRoleWarnings(baseRole)).toEqual([]);
  });

  it('warns when knowledgeDomains is empty', () => {
    const warnings = computeRoleWarnings({ ...baseRole, knowledgeDomains: [] });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('knowledgeDomains')]),
    );
  });

  it('warns when rolePrompt is null', () => {
    const warnings = computeRoleWarnings({ ...baseRole, rolePrompt: null });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('rolePrompt')]),
    );
  });

  it('warns when rolePrompt is blank/whitespace-only', () => {
    const warnings = computeRoleWarnings({ ...baseRole, rolePrompt: '   ' });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('rolePrompt')]),
    );
  });

  it('returns both warnings when both conditions apply', () => {
    const warnings = computeRoleWarnings({
      ...baseRole,
      knowledgeDomains: [],
      rolePrompt: null,
    });
    expect(warnings).toHaveLength(2);
  });
});

describe('computeCompanyWarnings', () => {
  it('returns no warnings when companyContext is set', () => {
    expect(computeCompanyWarnings(baseCompany)).toEqual([]);
  });

  it('warns when companyContext is null', () => {
    const warnings = computeCompanyWarnings({
      ...baseCompany,
      companyContext: null,
    });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('companyContext')]),
    );
  });

  it('warns when companyContext is blank/whitespace-only', () => {
    const warnings = computeCompanyWarnings({
      ...baseCompany,
      companyContext: '  ',
    });
    expect(warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('companyContext')]),
    );
  });
});
