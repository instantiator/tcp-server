import { canonicalArtifactType, canonicaliseArtifacts } from './LcpArtifact';

describe('canonicalArtifactType', () => {
  it('maps word aliases to inline-text', () => {
    expect(canonicalArtifactType('text')).toBe('inline-text');
    expect(canonicalArtifactType('inline')).toBe('inline-text');
    expect(canonicalArtifactType('string')).toBe('inline-text');
  });

  it('normalises case, spaces and underscores to canonical hyphenated form', () => {
    expect(canonicalArtifactType('inline_text')).toBe('inline-text');
    expect(canonicalArtifactType('Inline-Text')).toBe('inline-text');
    expect(canonicalArtifactType('assignment_working_path')).toBe(
      'assignment-working-path',
    );
    expect(canonicalArtifactType('  assignment working path ')).toBe(
      'assignment-working-path',
    );
  });

  it('leaves an already-canonical type unchanged', () => {
    expect(canonicalArtifactType('assignment-completed-path')).toBe(
      'assignment-completed-path',
    );
  });

  it('returns an unknown value normalised (still invalid, for the caller to reject)', () => {
    expect(canonicalArtifactType('totally_bogus')).toBe('totally-bogus');
  });
});

describe('canonicaliseArtifacts', () => {
  it('canonicalises each type and preserves value', () => {
    // Aliases arrive at runtime from LLM JSON, so the literal types are cast.
    expect(
      canonicaliseArtifacts([
        { type: 'text' as never, value: 'hi' },
        { type: 'inline_text' as never, value: 'yo' },
      ]),
    ).toEqual([
      { type: 'inline-text', value: 'hi' },
      { type: 'inline-text', value: 'yo' },
    ]);
  });
});
