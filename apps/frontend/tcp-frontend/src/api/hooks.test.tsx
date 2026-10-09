import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { WireEvent } from '@tcp/shared/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyEvent } from '../events/cache';
import {
  installFetchMock,
  requestedUrls,
  respondByRoute,
} from '../test-support/fetch-mock';
import {
  useCompanyKnowledgeList,
  useCompanyRolesList,
  useLiveAgentState,
  useLiveAssignmentsList,
  useLiveChatState,
  useLiveCompanyAgentsList,
  useLiveCompanyChatsList,
  useLiveCompanyConsultationsList,
  useLiveCompanyEnquiriesList,
  useLiveCompanyState,
  useLiveCompanyTasksList,
  useLiveConsultationState,
  useLiveEnquiryState,
  useLiveNotifications,
  useLiveTaskState,
  useRoleState,
} from './hooks';

// This file tests two things about hooks.ts: that each hook asks the network
// for what its doc comment says it does (GROUP 1), and that `applyEvent`
// patching the shared query cache actually reaches every `Live` hook reading
// it (GROUP 2/3) — the promise the file's own top comment makes. Mocking
// stops at `fetch` (ADR-028): a real `QueryClient` is used throughout, never
// a stub of TanStack Query itself.

const COMPANY_ID = 'company-1';
const NOW = '2026-08-09T00:00:00.000Z';

/**
 * `renderHook`, wrapped in a real `QueryClient` — modelled on `renderActivity`
 * in `CompanyTabs.test.tsx`. Returns the client alongside the render
 * result so a test can hand it straight to `applyEvent`.
 */
const renderHookWithClient = <T,>(callback: () => T) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    queryClient,
    ...renderHook(callback, {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    }),
  };
};

/** A live `state_change` audit event, as `useEventStream` hands to `applyEvent`. */
const auditEvent = (
  payload: Record<string, unknown>,
  agentId: string | null = null,
): WireEvent => ({
  type: 'audit',
  event: {
    timestamp: NOW,
    companyId: COMPANY_ID,
    role: 'system',
    agentId,
    assignmentId: null,
    taskId: null,
    eventType: 'state_change',
    payload,
  },
});

beforeEach(installFetchMock);
afterEach(() => vi.unstubAllGlobals());

describe('each hook asks for the right thing', () => {
  it('useLiveCompanyChatsList requests mode=chat', async () => {
    respondByRoute([[/\/api\/assignment\?/, { body: [] }]]);

    const { result } = renderHookWithClient(() =>
      useLiveCompanyChatsList(COMPANY_ID),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestedUrls()[0]);
    expect(url.searchParams.get('mode')).toBe('chat');
  });

  it("useLiveCompanyConsultationsList requests taskId='null' (the literal string) and mode=consultee", async () => {
    respondByRoute([[/\/api\/assignment\?/, { body: [] }]]);

    const { result } = renderHookWithClient(() =>
      useLiveCompanyConsultationsList(COMPANY_ID),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestedUrls()[0]);
    // The four-character string 'null', not JS `null` — ADR-023, see the
    // doc comment on useLiveCompanyConsultationsList in hooks.ts.
    expect(url.searchParams.get('taskId')).toBe('null');
    expect(url.searchParams.get('mode')).toBe('consultee');
  });

  it('useLiveCompanyEnquiriesList requests status=awaiting_user when given a status', async () => {
    respondByRoute([[/\/api\/conversation\?/, { body: [] }]]);

    const { result } = renderHookWithClient(() =>
      useLiveCompanyEnquiriesList(COMPANY_ID, 'awaiting_user'),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestedUrls()[0]);
    expect(url.searchParams.get('status')).toBe('awaiting_user');
  });

  it("useLiveNotifications requests the company's route", async () => {
    respondByRoute([[/\/api\/notifications\/company\/[^/?]+$/, { body: [] }]]);

    const { result } = renderHookWithClient(() =>
      useLiveNotifications(COMPANY_ID),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedUrls()).toHaveLength(1);
    expect(new URL(requestedUrls()[0]).pathname).toBe(
      `/api/notifications/company/${COMPANY_ID}`,
    );
  });

  it('useLiveAgentState({ agentId }) makes exactly one request, to /api/agent/{id}', async () => {
    respondByRoute([
      [/\/api\/agent\/[^/?]+$/, { body: { id: 'agent-1', status: 'idle' } }],
    ]);

    const { result } = renderHookWithClient(() =>
      useLiveAgentState({ agentId: 'agent-1' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedUrls()).toHaveLength(1);
    expect(new URL(requestedUrls()[0]).pathname).toBe('/api/agent/agent-1');
  });

  it('useLiveAgentState({ assignmentId }) makes exactly one request, to /api/agent?assignmentId=…, and data is the single row', async () => {
    respondByRoute([
      [/\/api\/agent\?/, { body: [{ id: 'agent-1', status: 'idle' }] }],
    ]);

    const { result } = renderHookWithClient(() =>
      useLiveAgentState({ assignmentId: 'assignment-1' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(requestedUrls()).toHaveLength(1);
    const url = new URL(requestedUrls()[0]);
    expect(url.pathname).toBe('/api/agent');
    expect(url.searchParams.get('assignmentId')).toBe('assignment-1');
    // A row, not a one-element array — the whole reason
    // `useAgentByAssignment` exists over the raw list hook.
    expect(result.current.data).toEqual({ id: 'agent-1', status: 'idle' });
  });

  it('useLiveAgentState({ assignmentId }) resolves to null, not undefined, when the list comes back empty', async () => {
    respondByRoute([[/\/api\/agent\?/, { body: [] }]]);

    const { result } = renderHookWithClient(() =>
      useLiveAgentState({ assignmentId: 'assignment-1' }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // `rows[0] ?? null` in endpoints.ts exists precisely so this resolves
    // rather than throwing: TanStack Query treats an `undefined` queryFn
    // result as a bug.
    expect(result.current.data).toBeNull();
  });

  it('useLiveAgentState({}) makes no request — both lookups are disabled', () => {
    respondByRoute([]);

    renderHookWithClient(() => useLiveAgentState({}));

    expect(requestedUrls()).toHaveLength(0);
  });
});

describe('the one-line aliases', () => {
  type AliasCase = readonly [
    string,
    () => { isSuccess: boolean; isError: boolean },
    RegExp,
  ];

  const cases: readonly AliasCase[] = [
    [
      'useLiveCompanyState',
      () => useLiveCompanyState('company-1'),
      /\/api\/company\/company-1(\?|$)/,
    ],
    [
      'useLiveCompanyAgentsList',
      () => useLiveCompanyAgentsList('company-1'),
      /\/api\/agent\?.*companyId=company-1/,
    ],
    [
      'useLiveCompanyTasksList',
      () => useLiveCompanyTasksList('company-1'),
      /\/api\/task\?.*companyId=company-1/,
    ],
    [
      'useCompanyRolesList',
      () => useCompanyRolesList('company-1'),
      /\/api\/company\/company-1\/roles/,
    ],
    [
      'useCompanyKnowledgeList',
      () => useCompanyKnowledgeList('company-1'),
      /\/api\/company\/company-1\/knowledge/,
    ],
    [
      'useLiveTaskState',
      () => useLiveTaskState('task-1'),
      /\/api\/task\/task-1$/,
    ],
    [
      'useLiveChatState',
      () => useLiveChatState('assignment-1'),
      /\/api\/assignment\/assignment-1$/,
    ],
    [
      'useLiveConsultationState',
      () => useLiveConsultationState('assignment-1'),
      /\/api\/assignment\/assignment-1$/,
    ],
    [
      'useLiveEnquiryState',
      () => useLiveEnquiryState('some-slug'),
      /\/api\/conversation\/some-slug$/,
    ],
    ['useRoleState', () => useRoleState('role-1'), /\/api\/role\/role-1$/],
    [
      'useLiveAssignmentsList',
      () => useLiveAssignmentsList({ companyId: 'company-1' }),
      /\/api\/assignment\?.*companyId=company-1/,
    ],
  ];

  // One route table covering every alias, rather than one per case: these
  // tests are about the rename/wiring being correct, not about any one
  // route's behaviour (that belongs to endpoints.test.tsx).
  const respondToEveryAliasRoute = (): void => {
    respondByRoute([
      [/\/api\/company\/[^/]+\/roles/, { body: [] }],
      [/\/api\/company\/[^/]+\/knowledge/, { body: [] }],
      [/\/api\/company\/[^/?]+(\?|$)/, { body: null }],
      [/\/api\/agent\?/, { body: [] }],
      [/\/api\/task\?/, { body: [] }],
      [/\/api\/task\/[^/?]+$/, { body: null }],
      [/\/api\/assignment\?/, { body: [] }],
      [/\/api\/assignment\/[^/?]+$/, { body: null }],
      [/\/api\/conversation\/[^/?]+$/, { body: null }],
      [/\/api\/role\/[^/?]+$/, { body: null }],
    ]);
  };

  it.each(cases)('%s hits its route', async (_name, useHook, expected) => {
    respondToEveryAliasRoute();

    const { result } = renderHookWithClient(useHook);
    await waitFor(() =>
      expect(result.current.isSuccess || result.current.isError).toBe(true),
    );

    expect(requestedUrls().some((url) => expected.test(url))).toBe(true);
  });
});

describe('each class of live change reaches the hook', () => {
  // TanStack Query's `useQuery` result is a tracked proxy: it only re-renders
  // an observer for properties that render actually read (v5's "tracked
  // queries"). A composed hook that hands back the raw `UseQueryResult`
  // objects untouched never reads `.data`, so a later patch updates the
  // cache but never notifies — the render stays frozen at the last property
  // it *did* read. Every helper below reads `.data`/`.status` up front for
  // exactly that reason; it is not decoration.

  /**
   * Composes the two hooks a task summary is supposed to patch.
   *
   * `detailData` is the whole object, not `.status` alone: `GET
   * /api/task/{id}` carries no `@ApiOkResponse` on the server (it also
   * actually returns `{ task, assignments }`, not a flat task — see the note
   * on the test below), so the generated schema types this route's response
   * `never` and a narrower field read does not compile. Comparing the whole
   * value with `toEqual` sidesteps that gap without reading through it.
   */
  const useTaskDetailAndList = (taskId: string, companyId: string) => {
    const detail = useLiveTaskState(taskId);
    const list = useLiveCompanyTasksList(companyId);
    return {
      detailIsSuccess: detail.isSuccess,
      detailData: detail.data,
      listIsSuccess: list.isSuccess,
      listStatus: list.data?.[0]?.status,
    };
  };

  it('a task summary patches useLiveTaskState, and the matching row inside useLiveCompanyTasksList', async () => {
    const initialTask = {
      id: 'task-1',
      companyId: COMPANY_ID,
      status: 'ready',
      request: 'Reconcile Q3 accounts',
      shortcode: 'TASK-1',
    };
    respondByRoute([
      [/\/api\/task\?/, { body: [initialTask] }],
      [/\/api\/task\/[^/?]+$/, { body: initialTask }],
    ]);

    const { result, queryClient } = renderHookWithClient(() =>
      useTaskDetailAndList('task-1', COMPANY_ID),
    );
    await waitFor(() => {
      expect(result.current.detailIsSuccess).toBe(true);
      expect(result.current.listIsSuccess).toBe(true);
    });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({
          entity: 'task',
          summary: {
            id: 'task-1',
            status: 'succeeded',
            request: initialTask.request,
            shortcode: initialTask.shortcode,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.detailData).toEqual({
        ...initialTask,
        status: 'succeeded',
      });
    });
    expect(result.current.listStatus).toBe('succeeded');
  });

  /** Composes the three hooks an agent summary is supposed to patch. */
  const useAgentLookupsAndList = (companyId: string) => {
    const byAgentId = useLiveAgentState({ agentId: 'agent-1' });
    const byAssignmentId = useLiveAgentState({ assignmentId: 'assignment-1' });
    const list = useLiveCompanyAgentsList(companyId);
    return {
      byAgentIdIsSuccess: byAgentId.isSuccess,
      byAgentIdStatus: byAgentId.data?.status,
      byAssignmentIdIsSuccess: byAssignmentId.isSuccess,
      byAssignmentIdStatus: byAssignmentId.data?.status,
      listIsSuccess: list.isSuccess,
      listStatus: list.data?.[0]?.status,
    };
  };

  it('an agent summary patches useLiveAgentState by either id, and a row inside useLiveCompanyAgentsList', async () => {
    const initialAgent = { id: 'agent-1', status: 'idle', roleId: 'role-1' };
    respondByRoute([
      // Ordered before the general agent-list route below: this one also
      // matches `?assignmentId=…`, and the first match wins.
      [/\/api\/agent\?.*assignmentId/, { body: [initialAgent] }],
      [/\/api\/agent\/[^/?]+$/, { body: initialAgent }],
      [/\/api\/agent\?/, { body: [initialAgent] }],
    ]);

    const { result, queryClient } = renderHookWithClient(() =>
      useAgentLookupsAndList(COMPANY_ID),
    );
    await waitFor(() => {
      expect(result.current.byAgentIdIsSuccess).toBe(true);
      expect(result.current.byAssignmentIdIsSuccess).toBe(true);
      expect(result.current.listIsSuccess).toBe(true);
    });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({
          entity: 'agent',
          summary: {
            id: 'agent-1',
            status: 'completed',
            roleId: 'role-1',
            assignmentId: null,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.byAgentIdStatus).toBe('completed');
    });
    expect(result.current.byAssignmentIdStatus).toBe('completed');
    expect(result.current.listStatus).toBe('completed');
  });

  it('an agent state_change with no summary still patches useLiveAgentState, via synthesiseAgentPatch', async () => {
    // 002.04's writers publish an agent `state_change` with no `summary` —
    // `cache.ts`'s `synthesiseAgentPatch` reconstructs `{ id, status }` from
    // the envelope's `agentId` and the payload's `newStatus` instead.
    // `src/events/cache.test.ts` covers the reconstruction itself; this
    // proves it reaches a `Live` hook's `data`.
    respondByRoute([
      [/\/api\/agent\/[^/?]+$/, { body: { id: 'agent-1', status: 'idle' } }],
    ]);

    const { result, queryClient } = renderHookWithClient(() =>
      useLiveAgentState({ agentId: 'agent-1' }),
    );
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
      // Reading `.data` here, not just `.isSuccess`, is what makes the
      // change below observable — see the note at the top of this describe.
      expect(result.current.data?.status).toBe('idle');
    });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'completed' }, 'agent-1'),
      );
    });

    await waitFor(() => {
      expect(result.current.data?.status).toBe('completed');
    });
  });

  /** Composes the three hooks an assignment summary is supposed to patch. */
  const useAssignmentViewsAndList = (id: string, companyId: string) => {
    const consultation = useLiveConsultationState(id);
    const chat = useLiveChatState(id);
    const list = useLiveAssignmentsList({ companyId });
    return {
      consultationIsSuccess: consultation.isSuccess,
      consultationStatus: consultation.data?.status,
      chatIsSuccess: chat.isSuccess,
      chatStatus: chat.data?.status,
      listIsSuccess: list.isSuccess,
      listStatus: list.data?.[0]?.status,
    };
  };

  it('an assignment summary patches useLiveConsultationState, useLiveChatState and a row inside useLiveAssignmentsList', async () => {
    const initialAssignment = {
      id: 'assignment-1',
      companyId: COMPANY_ID,
      status: 'ready',
      mode: 'consultee',
    };
    respondByRoute([
      [/\/api\/assignment\?/, { body: [initialAssignment] }],
      [/\/api\/assignment\/[^/?]+$/, { body: initialAssignment }],
    ]);

    const { result, queryClient } = renderHookWithClient(() =>
      useAssignmentViewsAndList('assignment-1', COMPANY_ID),
    );
    await waitFor(() => {
      expect(result.current.consultationIsSuccess).toBe(true);
      expect(result.current.chatIsSuccess).toBe(true);
      expect(result.current.listIsSuccess).toBe(true);
    });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({
          entity: 'assignment',
          summary: {
            id: 'assignment-1',
            status: 'succeeded',
            mode: 'consultee',
            orderIndex: null,
            roleId: 'role-1',
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.consultationStatus).toBe('succeeded');
    });
    expect(result.current.chatStatus).toBe('succeeded');
    expect(result.current.listStatus).toBe('succeeded');
  });

  it('an enquiry summary patches useLiveEnquiryState even though its key holds a slug and the summary holds an id', async () => {
    // `applyEvent` matches on the *cached value's* id, never on the query
    // key (see cache.ts). `useLiveEnquiryState`'s key is
    // `['enquiry','detail', slug]` — keyed by slug, because
    // `GET /api/conversation` has no by-id route — but the cached
    // conversation object itself carries an `id`, and that is what an
    // `EnquiryChangeSummary` is matched against. This is the least obvious
    // behaviour in hooks.ts.
    //
    // Asserted with `toEqual` on the whole `data` value, not a `.status`
    // field read: `GET /api/conversation/{slug}` carries no `@ApiOkResponse`
    // on the server, so the generated schema types this route's response
    // `never` and a narrower property read does not compile.
    const initialConversation = {
      id: 'conv-1',
      slug: 'which-vendor',
      companyId: COMPANY_ID,
      status: 'awaiting_user',
      roleName: 'Analyst',
      question: 'Which vendor should get priority?',
    };
    respondByRoute([
      [/\/api\/conversation\/[^/?]+$/, { body: initialConversation }],
    ]);

    const { result, queryClient } = renderHookWithClient(() =>
      useLiveEnquiryState('which-vendor'),
    );
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
      expect(result.current.data).toEqual(initialConversation);
    });

    act(() => {
      applyEvent(
        queryClient,
        auditEvent({
          entity: 'enquiry',
          summary: {
            id: 'conv-1',
            slug: 'which-vendor',
            status: 'closed',
            roleName: 'Analyst',
            question: initialConversation.question,
          },
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({
        ...initialConversation,
        status: 'closed',
      });
    });
  });

  it('a company event with no summary falls to the invalidate path, so useLiveCompanyState refetches', async () => {
    // wire-events.ts has no summary shape for `company` at all, so this
    // entity never takes the patch branch in applyEvent — it always
    // invalidates.
    const companyRoute = /\/api\/company\/[^/?]+(\?|$)/;
    respondByRoute([
      [companyRoute, { body: { id: 'company-1', name: 'Acme' } }],
    ]);

    const { result, queryClient } = renderHookWithClient(() =>
      useLiveCompanyState('company-1'),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      requestedUrls().filter((url) => companyRoute.test(url)),
    ).toHaveLength(1);

    act(() => {
      applyEvent(queryClient, auditEvent({ entity: 'company' }));
    });

    await waitFor(() => {
      expect(
        requestedUrls().filter((url) => companyRoute.test(url)),
      ).toHaveLength(2);
    });
  });
});

describe('STATIC_ENTITIES never refetch on a live event', () => {
  it('does not refetch useCompanyRolesList or useCompanyKnowledgeList when a live event fires', async () => {
    const rolesRoute = /\/api\/company\/[^/]+\/roles/;
    const knowledgeRoute = /\/api\/company\/[^/]+\/knowledge/;
    respondByRoute([
      [rolesRoute, { body: [] }],
      [knowledgeRoute, { body: [] }],
    ]);

    const useStaticLists = (companyId: string) => ({
      roles: useCompanyRolesList(companyId),
      knowledge: useCompanyKnowledgeList(companyId),
    });

    const { result, queryClient } = renderHookWithClient(() =>
      useStaticLists(COMPANY_ID),
    );
    await waitFor(() => {
      expect(result.current.roles.isSuccess).toBe(true);
      expect(result.current.knowledge.isSuccess).toBe(true);
    });

    const rolesRequestsBefore = requestedUrls().filter((url) =>
      rolesRoute.test(url),
    ).length;
    const knowledgeRequestsBefore = requestedUrls().filter((url) =>
      knowledgeRoute.test(url),
    ).length;

    // `role` and `knowledge` are STATIC_ENTITIES in query-keys.ts — nothing
    // streams them, so an event naming any of the five live entities must
    // leave both untouched.
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'task', summary: { id: 'task-1' } }),
      );
    });

    expect(requestedUrls().filter((url) => rolesRoute.test(url)).length).toBe(
      rolesRequestsBefore,
    );
    expect(
      requestedUrls().filter((url) => knowledgeRoute.test(url)).length,
    ).toBe(knowledgeRequestsBefore);
  });
});
