import { knowledgeKey } from './storage-keys';

describe('knowledgeKey', () => {
  it('builds the ADR-007 knowledge-file key layout', () => {
    expect(knowledgeKey('acme', 'analyst', 'report.md')).toBe(
      'acme/knowledge/analyst/report.md',
    );
  });
});
