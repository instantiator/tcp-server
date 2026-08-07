import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StreamDelta, WireEvent } from '@tcp/shared/client';

import { applyEvent } from './cache';
import { subscribe } from './subscriptions';

/**
 * Subscribes to one event stream for as long as the calling component is
 * mounted, folding every event into the query cache via {@link applyEvent}.
 *
 * `onDelta`, when given, additionally receives each {@link StreamDelta} — for
 * a caller holding token deltas in its own local state, which is where they
 * belong (never the query cache).
 *
 * `null` unsubscribes (or never subscribes), which is what lets a caller
 * express "no company selected yet" without a separate guard.
 */
export const useEventStream = (
  url: string | null,
  onDelta?: (delta: StreamDelta) => void,
): { error: Error | null } => {
  const queryClient = useQueryClient();
  const [error, setError] = useState<Error | null>(null);

  // Read through a ref rather than a dependency: an inline arrow the caller
  // passes fresh on every render would otherwise resubscribe the stream on
  // every render. The ref itself never changes, so exhaustive-deps needs
  // nothing added for it.
  const onDeltaRef = useRef(onDelta);
  onDeltaRef.current = onDelta;

  useEffect(() => {
    if (url === null) {
      setError(null);
      return;
    }

    const handleEvent = (event: WireEvent): void => {
      applyEvent(queryClient, event);
      if (event.type === 'stream') onDeltaRef.current?.(event);
    };

    try {
      return subscribe(url, handleEvent, setError);
    } catch (caught) {
      // The MAX_STREAMS cap throws synchronously rather than calling
      // `onError`, since refusing to open is not something a live connection
      // ever does. Turn it into state so it surfaces instead of escaping the
      // effect unhandled.
      setError(caught instanceof Error ? caught : new Error(String(caught)));
      return undefined;
    }
  }, [url, queryClient]);

  return { error };
};
