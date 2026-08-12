import { virtual } from '@guidepup/virtual-screen-reader';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AuditWireEvent, WireEvent } from '@tcp/shared/client';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { subscribe } from '../../events/subscriptions';
import { t } from '../../strings';
import {
  installFetchMock,
  respondByRoute,
} from '../../test-support/fetch-mock';
import { useTranscript } from './useTranscript';

vi.mock('../../events/subscriptions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/subscriptions')>()),
  subscribe: vi.fn(),
}));

const subscribeMock = vi.mocked(subscribe);

const AGENT_ID = 'agent-1';
const ROLE = 'Sales';

/** Captured from the last `subscribe` call, so a test can drive the stream. */
let emit: ((event: WireEvent) => void) | undefined;
let fail: ((error: Error) => void) | undefined;

const auditEvent = (
  overrides: Partial<AuditWireEvent> & Pick<AuditWireEvent, 'eventType'>,
): AuditWireEvent => ({
  id: 'audit-1',
  timestamp: '2026-08-07T09:00:00.000Z',
  companyId: 'company-1',
  role: 'sales',
  agentId: AGENT_ID,
  assignmentId: null,
  taskId: null,
  payload: {},
  ...overrides,
});

const delta = (text: string): WireEvent => ({
  type: 'stream',
  agentId: AGENT_ID,
  channel: 'response',
  delta: text,
  timestamp: '2026-08-07T09:00:01.000Z',
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      {children}
    </QueryClientProvider>
  </StrictMode>
);

/** Renders the hook with a history response already queued, and waits for it. */
const renderTranscript = async (
  history: AuditWireEvent[] = [],
  status = 200,
) => {
  respondByRoute([[/\/api\/agent\/.*\/history/, { status, body: history }]]);

  const result = renderHook(() => useTranscript(AGENT_ID, ROLE), { wrapper });
  await waitFor(() => {
    expect(result.result.current.status).not.toBe('loading');
  });
  return result;
};

describe('useTranscript', () => {
  beforeEach(() => {
    installFetchMock();
    emit = undefined;
    fail = undefined;
    subscribeMock.mockImplementation((_url, onEvent, onError) => {
      emit = onEvent;
      fail = onError as (error: Error) => void;
      return vi.fn();
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('primes from history before it opens a stream', async () => {
    const { result } = await renderTranscript([
      auditEvent({ eventType: 'input', payload: { text: 'Hello' } }),
    ]);

    expect(result.current.status).toBe('ready');
    expect(result.current.entries.map((e) => e.text)).toEqual(['Hello']);
    expect(subscribeMock).toHaveBeenCalledWith(
      `/api/agent/${AGENT_ID}/events`,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not subscribe until history has loaded', () => {
    respondByRoute([[/\/api\/agent\/.*\/history/, { body: [] }]]);
    renderHook(() => useTranscript(AGENT_ID, ROLE), { wrapper });

    // History and stream cannot be interleaved correctly without buffering
    // one of them, so the stream waits.
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('grows the open response as deltas arrive', async () => {
    const { result } = await renderTranscript();

    act(() => {
      emit?.(delta('Hel'));
    });
    expect(result.current.entries.at(-1)?.text).toBe('Hel');

    act(() => {
      emit?.(delta('lo'));
    });
    expect(result.current.entries.at(-1)?.text).toBe('Hello');
    expect(result.current.entries).toHaveLength(1);
  });

  it('reports a 403 on the stream as a refusal, not a wait', async () => {
    const { result } = await renderTranscript();

    act(() => {
      fail?.(new ApiError(403, 'refused', undefined));
    });

    expect(result.current.status).toBe('refused');
  });

  it('reports a 403 on history as a refusal too', async () => {
    const { result } = await renderTranscript([], 403);

    expect(result.current.status).toBe('refused');
  });

  it('reports the connection budget separately from a failure', async () => {
    subscribeMock.mockImplementation(() => {
      throw new Error(
        'Refusing to open event stream: 12 streams (MAX_STREAMS)',
      );
    });
    respondByRoute([[/\/api\/agent\/.*\/history/, { body: [] }]]);

    const { result } = renderHook(() => useTranscript(AGENT_ID, ROLE), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('at-capacity');
    });
  });

  describe('speech', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(async () => {
      await virtual.stop();
      vi.useRealTimers();
    });

    it('says nothing at all while a response streams', async () => {
      const { result } = await renderTranscript();
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      for (const token of 'a response arriving one token at a time'.split(
        ' ',
      )) {
        act(() => {
          emit?.(delta(`${token} `));
        });
      }
      // Past the announcer's throttle, so a coalesced announcement would have
      // been spoken by now. This is the failure ADR-027 exists to prevent:
      // suppression is this hook's job, not the throttle's.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(await virtual.spokenPhraseLog()).toEqual([]);
      expect(result.current.entries).toHaveLength(1);
    });

    it('announces once when the response completes, under StrictMode', async () => {
      await renderTranscript();
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      act(() => {
        emit?.(delta('Hello'));
      });
      act(() => {
        emit?.({
          type: 'audit',
          event: auditEvent({
            id: 'audit-response',
            eventType: 'llm_response',
            payload: { responseText: 'Hello' },
          }),
        });
      });
      await vi.advanceTimersByTimeAsync(15_000);

      // The announcer counts repeats, so a guard on "have I run?" rather than
      // on which response it was would say this twice under StrictMode.
      expect(await virtual.spokenPhraseLog()).toEqual([
        `polite: ${t('transcript.announce.response', { role: ROLE })}`,
      ]);
    });

    it('announces each completed response, not only the first', async () => {
      await renderTranscript();
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      for (const id of ['audit-one', 'audit-two']) {
        act(() => {
          emit?.({
            type: 'audit',
            event: auditEvent({ id, eventType: 'llm_response' }),
          });
        });
        await vi.advanceTimersByTimeAsync(15_000);
      }

      expect(await virtual.spokenPhraseLog()).toHaveLength(2);
    });

    it('says nothing for history, however much of it there is', async () => {
      await virtual.start({ container: document.body });
      await virtual.clearSpokenPhraseLog();

      await renderTranscript([
        auditEvent({ id: 'h1', eventType: 'llm_response' }),
        auditEvent({ id: 'h2', eventType: 'agent_loop_completion' }),
      ]);
      await vi.advanceTimersByTimeAsync(15_000);

      // Reopening a transcript re-primes it. Announcing what the user already
      // knows about would make every reopen a burst of speech.
      expect(await virtual.spokenPhraseLog()).toEqual([]);
    });
  });
});
