import { parseWireEvents, readWireStream } from './wire-stream';

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

function chunkedResponse(chunks: string[], ok = true, status = 200) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < chunks.length
              ? { done: false, value: encoder.encode(chunks[i++]) }
              : { done: true, value: undefined },
          ),
      }),
    },
  };
}

describe('readWireStream', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('invokes onEvent for each parsed wire event, in order', async () => {
    const wire = (delta: string) =>
      JSON.stringify({ type: 'stream', channel: 'response', delta });
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        chunkedResponse([`data: ${wire('a')}\n\n`, `data: ${wire('b')}\n\n`]),
      );

    const received: unknown[] = [];
    await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      (e) => received.push(e.type === 'stream' ? e.delta : undefined),
    );

    expect(received).toEqual(['a', 'b']);
  });

  it('sends the bearer token and passes the abort signal through', async () => {
    const fetchMock = jest.fn().mockResolvedValue(chunkedResponse([]));
    global.fetch = fetchMock;
    const controller = new AbortController();

    await readWireStream(
      'http://x/events',
      'my-token',
      controller.signal,
      () => {},
    );

    expect(fetchMock).toHaveBeenCalledWith('http://x/events', {
      headers: { Authorization: 'Bearer my-token' },
      signal: controller.signal,
    });
  });

  it('resolves { reason: "failed", status } when the response is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue(chunkedResponse([], false, 403));

    const onEvent = jest.fn();
    const result = await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      onEvent,
    );

    expect(onEvent).not.toHaveBeenCalled();
    expect(result).toEqual({ reason: 'failed', status: 403 });
  });

  it('resolves { reason: "failed", status: 0 } when the response is ok but has no body', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: null });

    const result = await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      () => {},
    );

    expect(result).toEqual({ reason: 'failed', status: 0 });
  });

  it('resolves { reason: "done" } when the reader reports done', async () => {
    global.fetch = jest.fn().mockResolvedValue(chunkedResponse([]));

    const result = await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      () => {},
    );

    expect(result).toEqual({ reason: 'done' });
  });

  it('resolves { reason: "aborted" } rather than throwing when the signal fired', async () => {
    const controller = new AbortController();
    global.fetch = jest.fn().mockImplementation(() => {
      controller.abort();
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const result = await readWireStream(
      'http://x/events',
      'tok',
      controller.signal,
      () => {},
    );

    expect(result).toEqual({ reason: 'aborted' });
  });

  it('resolves { reason: "failed", status: 0, cause } for any other thrown error', async () => {
    const cause = new Error('network down');
    global.fetch = jest.fn().mockRejectedValue(cause);

    const result = await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      () => {},
    );

    expect(result).toEqual({ reason: 'failed', status: 0, cause });
  });

  it('calls onOpen exactly once, before any events are delivered', async () => {
    const wire = JSON.stringify({
      type: 'stream',
      channel: 'response',
      delta: 'a',
    });
    global.fetch = jest
      .fn()
      .mockResolvedValue(chunkedResponse([`data: ${wire}\n\n`]));

    const calls: string[] = [];
    const onOpen = jest.fn(() => calls.push('open'));
    await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      () => calls.push('event'),
      onOpen,
    );

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['open', 'event']);
  });

  it('does not call onOpen when the response is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue(chunkedResponse([], false));
    const onOpen = jest.fn();

    await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      () => {},
      onOpen,
    );

    expect(onOpen).not.toHaveBeenCalled();
  });
});
