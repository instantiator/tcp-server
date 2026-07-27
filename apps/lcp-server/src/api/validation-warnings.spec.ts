import type { TcpCompany, TcpRole, LlmConfig } from '@lcp/shared';
import type { Response } from 'express';
import {
  WARNINGS_HEADER,
  computeCompanyWarnings,
  computeEmbeddingConfigWarning,
  computeRoleWarnings,
  setWarningsHeader,
} from './validation-warnings';

const baseRole = {
  knowledgeDomains: ['finance'],
  rolePrompt: 'You are a careful analyst.',
} as TcpRole;

const baseCompany = {
  companyContext: 'We build widgets.',
} as TcpCompany;

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

describe('computeEmbeddingConfigWarning', () => {
  const embeddingConfig: LlmConfig = { provider: 'lm-studio', model: 'embed' };

  it('returns no warnings when the company has its own embeddingConfig', () => {
    expect(
      computeEmbeddingConfigWarning({ embeddingConfig } as TcpCompany, null),
    ).toEqual([]);
  });

  it('returns no warnings when the company has none but an env fallback is set', () => {
    expect(
      computeEmbeddingConfigWarning(
        { embeddingConfig: null } as TcpCompany,
        embeddingConfig,
      ),
    ).toEqual([]);
  });

  it('warns when neither the company nor an env fallback resolves', () => {
    const warnings = computeEmbeddingConfigWarning(
      { embeddingConfig: null } as TcpCompany,
      null,
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No embedding config resolved'),
      ]),
    );
  });
});

describe('setWarningsHeader', () => {
  function fakeRes(): jest.Mocked<Pick<Response, 'setHeader'>> {
    return { setHeader: jest.fn() };
  }

  it('sets the header as a JSON array of percent-encoded warnings', () => {
    const res = fakeRes();
    setWarningsHeader(res as unknown as Response, ['a warning']);
    expect(res.setHeader).toHaveBeenCalledWith(
      WARNINGS_HEADER,
      JSON.stringify([encodeURIComponent('a warning')]),
    );
  });

  it("percent-encodes non-Latin1 content so it never reaches Node's header validation unescaped (e.g. an em dash, or an arbitrary third-party error message from KnowledgeService.embeddingWarnings)", () => {
    const res = fakeRes();
    setWarningsHeader(res as unknown as Response, [
      'Last reindex failed: connect refused — 例え話',
    ]);
    const [, value] = res.setHeader.mock.calls[0] as [string, string];
    // The whole point: every character actually sent is printable ASCII.
    expect(/^[\x20-\x7e]*$/.test(value)).toBe(true);
    expect(JSON.parse(value)).toEqual([
      encodeURIComponent('Last reindex failed: connect refused — 例え話'),
    ]);
  });

  it('omits the header entirely when there are no warnings', () => {
    const res = fakeRes();
    setWarningsHeader(res as unknown as Response, []);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('swallows a header-set failure rather than throwing, as a backstop', () => {
    const res = fakeRes();
    res.setHeader.mockImplementation(() => {
      throw new TypeError(
        'Invalid character in header content ["X-Tcp-Warnings"]',
      );
    });
    expect(() =>
      setWarningsHeader(res as unknown as Response, ['a warning']),
    ).not.toThrow();
  });
});
