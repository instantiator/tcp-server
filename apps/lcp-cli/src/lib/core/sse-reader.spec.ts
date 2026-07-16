import { readSseStream } from './sse-reader';

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

describe('readSseStream', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('invokes onEvent for each parsed SSE event, in order', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        chunkedResponse([
          `data: ${JSON.stringify({ kind: 'a', timestamp: 't1' })}\n\n`,
          `data: ${JSON.stringify({ kind: 'b', timestamp: 't2' })}\n\n`,
        ]),
      );

    const received: string[] = [];
    await readSseStream(
      'http://x/events',
      'tok',
      new AbortController().signal,
      (e) => received.push(e.kind),
    );

    expect(received).toEqual(['a', 'b']);
  });

  it('sends the bearer token and passes the abort signal through', async () => {
    const fetchMock = jest.fn().mockResolvedValue(chunkedResponse([]));
    global.fetch = fetchMock;
    const controller = new AbortController();

    await readSseStream(
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
    await readSseStream(
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
      readSseStream(
        'http://x/events',
        'tok',
        new AbortController().signal,
        () => {},
      ),
    ).resolves.toBeUndefined();
  });
});
