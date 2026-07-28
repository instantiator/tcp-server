import { resolveSystemPromptTemplate } from './resolve-system-prompt-template';

const DEFAULT_TEMPLATE = 'default template';

describe('resolveSystemPromptTemplate', () => {
  it('uses the role value when set', () => {
    expect(
      resolveSystemPromptTemplate(
        { systemPromptTemplate: 'role template' },
        { systemPromptTemplate: 'company template' },
        DEFAULT_TEMPLATE,
      ),
    ).toBe('role template');
  });

  it('falls through to company when the role has none', () => {
    expect(
      resolveSystemPromptTemplate(
        { systemPromptTemplate: null },
        { systemPromptTemplate: 'company template' },
        DEFAULT_TEMPLATE,
      ),
    ).toBe('company template');
  });

  it('falls through to the baked-in default when neither role nor company is set', () => {
    expect(
      resolveSystemPromptTemplate(
        { systemPromptTemplate: null },
        { systemPromptTemplate: null },
        DEFAULT_TEMPLATE,
      ),
    ).toBe(DEFAULT_TEMPLATE);
  });

  it('treats null role and company the same as unset', () => {
    expect(resolveSystemPromptTemplate(null, null, DEFAULT_TEMPLATE)).toBe(
      DEFAULT_TEMPLATE,
    );
  });

  it('treats a blank or whitespace-only string the same as unset', () => {
    expect(
      resolveSystemPromptTemplate(
        { systemPromptTemplate: '' },
        { systemPromptTemplate: 'company template' },
        DEFAULT_TEMPLATE,
      ),
    ).toBe('company template');

    expect(
      resolveSystemPromptTemplate(
        { systemPromptTemplate: '   ' },
        { systemPromptTemplate: null },
        DEFAULT_TEMPLATE,
      ),
    ).toBe(DEFAULT_TEMPLATE);
  });
});
