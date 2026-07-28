import { readWireStream } from './sse-reader';

function chunkedResponse(chunks: string[], ok = true) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok,
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

  it('does nothing when the response is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue(chunkedResponse([], false));

    const onEvent = jest.fn();
    await readWireStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      onEvent,
    );

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('swallows a fetch failure rather than throwing', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    await expect(
      readWireStream(
        'http://x/events',
        'tok',
        new AbortController().signal,
        () => {},
      ),
    ).resolves.toBeUndefined();
  });
});
