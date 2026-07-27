import { parseWireEvents } from './sse';

/** A response-delta WireEvent, serialized as it crosses the SSE `data:` line. */
const delta = (d: string) =>
  JSON.stringify({ type: 'stream', channel: 'response', delta: d });

describe('parseWireEvents', () => {
  it('parses complete events and keeps the trailing partial in rest', () => {
    const buffer =
      `data: ${delta('a')}\n\n` +
      `data: ${delta('b')}\n\n` +
      'data: {"type":"stream","channel":"response","delta":"c';
    const { events, rest } = parseWireEvents(buffer);
    expect(
      events.map((e) => (e.type === 'stream' ? e.delta : undefined)),
    ).toEqual(['a', 'b']);
    expect(rest).toBe('data: {"type":"stream","channel":"response","delta":"c');
  });

  it('parses an audit WireEvent', () => {
    const wire = JSON.stringify({
      type: 'audit',
      event: { eventType: 'state_change', payload: { entity: 'agent' } },
    });
    const { events } = parseWireEvents(`data: ${wire}\n\n`);
    expect(events[0].type).toBe('audit');
  });

  it('skips events without a data line', () => {
    const { events } = parseWireEvents(
      `event: ping\n\ndata: ${delta('x')}\n\n`,
    );
    expect(events).toHaveLength(1);
  });

  it('ignores malformed JSON rather than throwing', () => {
    const { events } = parseWireEvents(
      `data: not json\n\ndata: ${delta('ok')}\n\n`,
    );
    expect(events).toHaveLength(1);
  });

  it('returns no events and buffers everything when no boundary is present', () => {
    const { events, rest } = parseWireEvents(`data: ${delta('partial')}`);
    expect(events).toEqual([]);
    expect(rest).toBe(`data: ${delta('partial')}`);
  });
});
