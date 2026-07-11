import {
  knowledgeKey,
  knowledgePrefix,
  knowledgeScopeKey,
  knowledgeScopePrefix,
  parseKnowledgePath,
  sharedKnowledgeKey,
  sharedKnowledgePrefix,
} from './storage-keys';

describe('knowledgeKey', () => {
  it('builds the slug-based knowledge-file key layout', () => {
    expect(knowledgeKey('acme', 'analyst', 'report.md')).toBe(
      'acme/knowledge/analyst/report.md',
    );
  });
});

describe('sharedKnowledgeKey', () => {
  it('builds the company-shared knowledge-file key layout', () => {
    expect(sharedKnowledgeKey('acme', 'report.md')).toBe(
      'acme/knowledge/shared/report.md',
    );
  });
});

describe('knowledgePrefix', () => {
  it('builds the role knowledge-listing prefix', () => {
    expect(knowledgePrefix('acme', 'analyst')).toBe('acme/knowledge/analyst/');
  });
});

describe('sharedKnowledgePrefix', () => {
  it('builds the company-shared knowledge-listing prefix', () => {
    expect(sharedKnowledgePrefix('acme')).toBe('acme/knowledge/shared/');
  });
});

describe('knowledgeScopeKey', () => {
  it('builds a role-scoped key when roleSlug is set', () => {
    expect(
      knowledgeScopeKey({ companySlug: 'acme', roleSlug: 'analyst' }, 'a.md'),
    ).toBe('acme/knowledge/analyst/a.md');
  });

  it('builds a shared-scoped key when roleSlug is null', () => {
    expect(
      knowledgeScopeKey({ companySlug: 'acme', roleSlug: null }, 'a.md'),
    ).toBe('acme/knowledge/shared/a.md');
  });
});

describe('knowledgeScopePrefix', () => {
  it('builds a role-scoped prefix when roleSlug is set', () => {
    expect(
      knowledgeScopePrefix({ companySlug: 'acme', roleSlug: 'analyst' }),
    ).toBe('acme/knowledge/analyst/');
  });

  it('builds a shared-scoped prefix when roleSlug is null', () => {
    expect(knowledgeScopePrefix({ companySlug: 'acme', roleSlug: null })).toBe(
      'acme/knowledge/shared/',
    );
  });
});

describe('parseKnowledgePath', () => {
  it('parses a role knowledge key', () => {
    expect(parseKnowledgePath('acme/knowledge/analyst/report.md')).toEqual({
      companySlug: 'acme',
      roleSlug: 'analyst',
    });
  });

  it('maps the shared/ segment to a null role', () => {
    expect(parseKnowledgePath('acme/knowledge/shared/policy.md')).toEqual({
      companySlug: 'acme',
      roleSlug: null,
    });
  });

  it('returns null for non-knowledge keys', () => {
    expect(parseKnowledgePath('acme/tasks/123/output.md')).toBeNull();
    expect(parseKnowledgePath('acme/knowledge/analyst')).toBeNull();
    expect(parseKnowledgePath('report.md')).toBeNull();
  });
});
