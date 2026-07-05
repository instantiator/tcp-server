import { formatCompactionEvent, parseSseBuffer } from './sse';

describe('parseSseBuffer', () => {
  it('parses complete events and keeps the trailing partial in rest', () => {
    const buffer =
      'data: {"kind":"a"}\n\n' + 'data: {"kind":"b"}\n\n' + 'data: {"kind":"c';
    const { events, rest } = parseSseBuffer(buffer);
    expect(events.map((e) => e.kind)).toEqual(['a', 'b']);
    expect(rest).toBe('data: {"kind":"c');
  });

  it('skips events without a data line', () => {
    const { events } = parseSseBuffer('event: ping\n\ndata: {"kind":"x"}\n\n');
    expect(events.map((e) => e.kind)).toEqual(['x']);
  });

  it('ignores malformed JSON rather than throwing', () => {
    const { events } = parseSseBuffer(
      'data: not json\n\ndata: {"kind":"ok"}\n\n',
    );
    expect(events.map((e) => e.kind)).toEqual(['ok']);
  });

  it('returns no events and buffers everything when no boundary is present', () => {
    const { events, rest } = parseSseBuffer('data: {"kind":"partial"}');
    expect(events).toEqual([]);
    expect(rest).toBe('data: {"kind":"partial"}');
  });
});

describe('formatCompactionEvent', () => {
  it('formats a compaction_started event', () => {
    const line = formatCompactionEvent({
      kind: 'compaction_started',
      data: {
        strategies: ['trim', 'summarise'],
        tokensBefore: 900,
        windowSize: 1000,
        pct: 90,
      },
    });
    expect(line).toBe(
      '[Context compacting: strategies=[trim, summarise], 900/1000 tokens (90%)]',
    );
  });

  it('formats a compaction_complete event', () => {
    const line = formatCompactionEvent({
      kind: 'compaction_complete',
      data: { tokensAfter: 400, windowSize: 1000, pctAfter: 40 },
    });
    expect(line).toBe('[Context compacted: 400/1000 tokens (40%)]');
  });

  it('substitutes ? for missing numeric fields', () => {
    const line = formatCompactionEvent({ kind: 'compaction_started' });
    expect(line).toBe('[Context compacting: strategies=[], ?/? tokens (?%)]');
  });

  it('returns null for unrelated event kinds', () => {
    expect(formatCompactionEvent({ kind: 'processing_started' })).toBeNull();
  });
});
