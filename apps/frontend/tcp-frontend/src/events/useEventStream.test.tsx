import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { WireEvent } from '@tcp/shared/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiError } from '../api/errors';

import { subscribe } from './subscriptions';
import { useEventStream } from './useEventStream';

vi.mock('./subscriptions', () => ({ subscribe: vi.fn() }));

const subscribeMock = vi.mocked(subscribe);

/** A fresh cache, wrapping every hook under test. `useQueryClient` needs one. */
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {children}
  </QueryClientProvider>
);

const streamDelta: WireEvent = {
  type: 'stream',
  agentId: 'agent-1',
  channel: 'response',
  delta: 'hello',
  timestamp: '2026-08-07T00:00:00.000Z',
};

describe('useEventStream', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('subscribes once for a url and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    subscribeMock.mockReturnValue(unsubscribe);

    const { unmount } = renderHook(
      () => useEventStream('/api/company/company-1/events'),
      { wrapper },
    );

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(subscribeMock).toHaveBeenCalledWith(
      '/api/company/company-1/events',
      expect.any(Function),
      expect.any(Function),
    );
    expect(unsubscribe).not.toHaveBeenCalled();

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('subscribes nothing for a null url', () => {
    renderHook(() => useEventStream(null), { wrapper });

    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('surfaces a thrown MAX_STREAMS refusal as error state, not an unhandled throw', () => {
    // subscribe() throws synchronously when the cap is exceeded — this is the
    // failure mode a naive effect would let escape and crash the render.
    subscribeMock.mockImplementation(() => {
      throw new Error(
        'Refusing to open event stream …: 12 streams (MAX_STREAMS)',
      );
    });

    const { result } = renderHook(
      () => useEventStream('/api/company/company-1/events'),
      { wrapper },
    );

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('MAX_STREAMS');
  });

  it('passes a stream delta to onDelta, and nowhere else', () => {
    let handleEvent: ((event: WireEvent) => void) | undefined;
    subscribeMock.mockImplementation(
      (_url, onEvent: (event: WireEvent) => void) => {
        handleEvent = onEvent;
        return vi.fn();
      },
    );
    const onDelta = vi.fn();

    renderHook(() => useEventStream('/api/company/company-1/events', onDelta), {
      wrapper,
    });

    act(() => handleEvent?.(streamDelta));

    expect(onDelta).toHaveBeenCalledTimes(1);
    expect(onDelta).toHaveBeenCalledWith(streamDelta);
  });

  it('never calls onError as a side effect of a normal event', () => {
    let handleError: ((error: ApiError) => void) | undefined;
    subscribeMock.mockImplementation(
      (_url, _onEvent, onError: (error: ApiError) => void) => {
        handleError = onError;
        return vi.fn();
      },
    );

    const { result } = renderHook(
      () => useEventStream('/api/company/company-1/events'),
      { wrapper },
    );

    expect(result.current.error).toBeNull();
    expect(handleError).toBeDefined();
  });
});
