import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './errors';
import { queryKeys } from './query-keys';
import {
  useAgents,
  useAssignments,
  useCompanies,
  useCompany,
  useCompanyRoles,
  useCompanyUsers,
  useConversations,
  useRoleKnowledge,
  useTasks,
} from './endpoints';

// One representative hook per entity, not all 21 — the point of this file is
// that a hook's key and its request agree, not that every filter on every
// route is exercised (that belongs to a test of the route itself, on the
// server). No user is signed in: none of these hooks need one.

window.__TCP_CONFIG__ = {
  oidcIssuerUrl: 'https://idp.example.com',
  oidcClientId: 'test-web-client',
};

const fetchMock = vi.fn<typeof fetch>();

/** Answers the next request with a 200 and a JSON body. */
const respondWith = (body: unknown) => {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
};

/** The request the client made, so a test can read its URL. */
const requestMade = (): Request => {
  const request = fetchMock.mock.calls[0]?.[0];
  if (!(request instanceof Request)) throw new Error('no request was made');
  return request;
};

/**
 * A `QueryClientProvider` around a fresh cache, as a `renderHook` wrapper.
 *
 * A plain function returning `createElement`, not a `.tsx` component: this
 * file is `.ts`, matching every other file under `src/api/`, and JSX syntax
 * is unavailable without it.
 */
const wrapper =
  (queryClient: QueryClient) =>
  ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

describe('the read hooks', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    // Retries off: a hook answered with an error would otherwise sit retrying
    // for real backoff delays before `waitFor` ever saw `isError`.
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // `mockReset`, not `mockClear`: a queued `mockResolvedValueOnce` a failing
    // test never consumed would otherwise survive to answer the next test's
    // first request instead.
    fetchMock.mockReset();
    vi.clearAllMocks();
  });

  it('useCompanies requests GET /api/company with its filters, and lands under queryKeys.companies', async () => {
    respondWith([{ id: 'company-1', name: 'Acme' }]);

    const { result } = renderHook(() => useCompanies({ all: true }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe('/api/company');
    expect(url.search).toBe('?all=true');
    expect(
      queryClient.getQueryData(queryKeys.companies({ all: true })),
    ).toEqual([{ id: 'company-1', name: 'Acme' }]);
  });

  it('useCompany requests GET /api/company/{id}, and lands under queryKeys.company', async () => {
    respondWith({ id: 'company-1', name: 'Acme' });

    const { result } = renderHook(() => useCompany('company-1'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(new URL(requestMade().url).pathname).toBe('/api/company/company-1');
    expect(queryClient.getQueryData(queryKeys.company('company-1'))).toEqual({
      id: 'company-1',
      name: 'Acme',
    });
  });

  it('useAgents requests GET /api/agent with its filters, and lands under queryKeys.agents', async () => {
    respondWith([{ id: 'agent-1', status: 'idle' }]);

    const { result } = renderHook(() => useAgents({ companyId: 'company-1' }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe('/api/agent');
    expect(url.search).toBe('?companyId=company-1');
    expect(
      queryClient.getQueryData(queryKeys.agents({ companyId: 'company-1' })),
    ).toEqual([{ id: 'agent-1', status: 'idle' }]);
  });

  it('useTasks requests GET /api/task with its filters, and lands under queryKeys.tasks', async () => {
    respondWith([{ id: 'task-1', status: 'in-progress' }]);

    const { result } = renderHook(() => useTasks({ companyId: 'company-1' }), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe('/api/task');
    expect(url.search).toBe('?companyId=company-1');
    expect(
      queryClient.getQueryData(queryKeys.tasks({ companyId: 'company-1' })),
    ).toEqual([{ id: 'task-1', status: 'in-progress' }]);
  });

  it('useAssignments requests GET /api/assignment with its filters, and lands under queryKeys.assignments', async () => {
    respondWith([{ id: 'assignment-1', mode: 'consultee' }]);

    const params = { companyId: 'company-1', mode: 'consultee' as const };
    const { result } = renderHook(() => useAssignments(params), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe('/api/assignment');
    expect(url.search).toBe('?companyId=company-1&mode=consultee');
    expect(queryClient.getQueryData(queryKeys.assignments(params))).toEqual([
      { id: 'assignment-1', mode: 'consultee' },
    ]);
  });

  it('useConversations requests GET /api/conversation, and lands under queryKeys.conversations (entity "enquiry")', async () => {
    respondWith([{ id: 'conversation-1', status: 'open' }]);

    const params = { companyId: 'company-1' };
    const { result } = renderHook(() => useConversations(params), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe('/api/conversation');
    expect(url.search).toBe('?companyId=company-1');
    // The key is what invalidation matches on — see query-keys.test.ts for why
    // it disagrees with the route.
    expect(queryKeys.conversations(params)[0]).toBe('enquiry');
    expect(queryClient.getQueryData(queryKeys.conversations(params))).toEqual([
      { id: 'conversation-1', status: 'open' },
    ]);
  });

  it('useCompanyRoles requests GET /api/company/{id}/roles, and lands under queryKeys.companyRoles', async () => {
    respondWith([{ id: 'role-1', name: 'Engineer' }]);

    const { result } = renderHook(() => useCompanyRoles('company-1'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(new URL(requestMade().url).pathname).toBe(
      '/api/company/company-1/roles',
    );
    expect(
      queryClient.getQueryData(queryKeys.companyRoles('company-1')),
    ).toEqual([{ id: 'role-1', name: 'Engineer' }]);
  });

  it('useCompanyUsers requests GET /api/company/{companyId}/users, and lands under queryKeys.companyUsers', async () => {
    respondWith([{ id: 'user-1', role: 'admin' }]);

    const { result } = renderHook(() => useCompanyUsers('company-1'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(new URL(requestMade().url).pathname).toBe(
      '/api/company/company-1/users',
    );
    expect(
      queryClient.getQueryData(queryKeys.companyUsers('company-1')),
    ).toEqual([{ id: 'user-1', role: 'admin' }]);
  });

  it('useRoleKnowledge requests GET /api/role/{roleId}/knowledge, and lands under queryKeys.roleKnowledge', async () => {
    respondWith([{ filename: 'onboarding.md' }]);

    const { result } = renderHook(() => useRoleKnowledge('role-1'), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(new URL(requestMade().url).pathname).toBe(
      '/api/role/role-1/knowledge',
    );
    expect(queryClient.getQueryData(queryKeys.roleKnowledge('role-1'))).toEqual(
      [{ filename: 'onboarding.md' }],
    );
  });

  it('surfaces a failed request as an ApiError, not a hang or a silent success', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ statusCode: 500, message: 'boom' }), {
        status: 500,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const { result } = renderHook(() => useCompanies(), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    const { error } = result.current;
    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) {
      throw new Error('expected the query to fail with an ApiError');
    }
    expect(error.status).toBe(500);
  });
});
