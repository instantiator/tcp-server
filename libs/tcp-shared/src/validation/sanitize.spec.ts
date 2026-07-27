import {
  sanitiseArtifacts,
  sanitiseArtifactsColumn,
  sanitiseTextColumn,
  stripControlChars,
} from './sanitize';

describe('stripControlChars', () => {
  it('removes C0 control chars and DEL that break strict JSON parsers', () => {
    const dirty = `ok${String.fromCharCode(0x1b)}[31m${String.fromCharCode(0)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x7f)}end`;
    const clean = stripControlChars(dirty);
    expect(clean).toBe('ok[31mend');
    // The result round-trips through strict JSON unchanged.
    const roundTripped = JSON.parse(JSON.stringify({ v: clean })) as {
      v: string;
    };
    expect(roundTripped.v).toBe('ok[31mend');
  });

  it('preserves legitimate whitespace (tab, newline, carriage return)', () => {
    const text = 'line1\n\tindented\r\nline2';
    expect(stripControlChars(text)).toBe(text);
  });

  it('leaves ordinary text (incl. emoji/unicode) untouched', () => {
    expect(stripControlChars('grubs & worms 🐛 café')).toBe(
      'grubs & worms 🐛 café',
    );
  });
});

describe('column transformers', () => {
  const CTRL = String.fromCharCode(0x1b);

  it('sanitiseTextColumn strips on write, passes non-strings through', () => {
    expect(sanitiseTextColumn.to(`hi${CTRL}there`)).toBe('hithere');
    expect(sanitiseTextColumn.to(null)).toBeNull();
    expect(sanitiseTextColumn.to(undefined)).toBeUndefined();
    // read passes through untouched
    expect(sanitiseTextColumn.from(`hi${CTRL}`)).toBe(`hi${CTRL}`);
  });

  it('sanitiseArtifacts strips control chars from every artifact value', () => {
    expect(
      sanitiseArtifacts([
        { type: 'inline-text', value: `note${CTRL}s` },
        { type: 'assignment-working-path', value: 'out.md' },
      ]),
    ).toEqual([
      { type: 'inline-text', value: 'notes' },
      { type: 'assignment-working-path', value: 'out.md' },
    ]);
    expect(sanitiseArtifacts(null)).toBeNull();
  });

  it('sanitiseArtifactsColumn strips on write, leaves non-arrays alone', () => {
    expect(
      sanitiseArtifactsColumn.to([{ type: 'inline-text', value: `a${CTRL}b` }]),
    ).toEqual([{ type: 'inline-text', value: 'ab' }]);
    expect(sanitiseArtifactsColumn.to(null)).toBeNull();
  });
});
