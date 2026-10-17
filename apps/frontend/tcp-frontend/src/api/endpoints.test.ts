import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './errors';
import type { components } from './schema';
import { queryKeys } from './query-keys';
import {
  useAgents,
  useAssignments,
  useCompanies,
  useCompany,
  useCompanyKnowledgeSearch,
  useCompanyRoles,
  useCompanyUsers,
  useConversations,
  useCreateRoleMutation,
  useDeleteKnowledgeMutation,
  useCreateCompanyMutation,
  useDeleteCompanyMutation,
  useDeleteRoleMutation,
  useLlmDefaults,
  useLocalModelsQuery,
  useMcpServers,
  useToolFootprintQuery,
  useReindexKnowledgeMutation,
  useRoleKnowledge,
  useTasks,
  useUpdateCompanyMutation,
  useUpdateRoleMutation,
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

  it('useCompanyKnowledgeSearch requests GET /api/company/{companyId}/knowledge/query with ?q=', async () => {
    respondWith([]);

    const { result } = renderHook(
      () => useCompanyKnowledgeSearch('company-1', 'refund policy'),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe('/api/company/company-1/knowledge/query');
    expect(url.search).toBe('?q=refund%20policy');
  });

  it('useMcpServers requests GET /api/mcp-servers', async () => {
    respondWith([{ name: 'storage', usage: 'files', available: true }]);

    const { result } = renderHook(() => useMcpServers(), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(new URL(requestMade().url).pathname).toBe('/api/mcp-servers');
  });

  it('useLlmDefaults requests GET /api/system/llm-defaults', async () => {
    respondWith({ chat: null, embedding: null, embeddingDimension: 768 });

    const { result } = renderHook(() => useLlmDefaults(), {
      wrapper: wrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(new URL(requestMade().url).pathname).toBe(
      '/api/system/llm-defaults',
    );
  });

  it('useLocalModelsQuery sends nothing until it has a server to ask', () => {
    renderHook(() => useLocalModelsQuery('company-1', null), {
      wrapper: wrapper(queryClient),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('useLocalModelsQuery POSTs a typed key in the body, never in the cache key', async () => {
    respondWith({ models: ['gemma'] });
    const query = {
      provider: 'lm-studio',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'typed-key',
    };

    const { result } = renderHook(
      () => useLocalModelsQuery('company-1', query),
      { wrapper: wrapper(queryClient) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const request = requestMade();
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe(
      '/api/company/company-1/llm/models',
    );
    expect(await request.json()).toEqual(query);
    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((q) => JSON.stringify(q.queryKey));
    expect(keys.join()).not.toContain('typed-key');
  });

  it('useToolFootprintQuery waits for a slug, then asks for the mode', async () => {
    respondWith({ mode: 'implement', servers: [], total: 0 });

    const { result, rerender } = renderHook(
      ({ slug }: { slug?: string }) =>
        useToolFootprintQuery('company-1', slug, 'implement'),
      { wrapper: wrapper(queryClient), initialProps: {} },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    rerender({ slug: 'writer' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const url = new URL(requestMade().url);
    expect(url.pathname).toBe(
      '/api/company/company-1/roles/by-slug/writer/tool-footprint',
    );
    expect(url.search).toBe('?mode=implement');
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

describe('the role and knowledge mutations', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    queryClient = new QueryClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('useCreateRoleMutation POSTs /api/role and returns the decoded warnings', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'r1', name: 'Clerk' }), {
        status: 201,
        headers: {
          'Content-Type': 'application/json',
          'X-Tcp-Warnings': JSON.stringify([encodeURIComponent('no café')]),
        },
      }),
    );

    const { result } = renderHook(() => useCreateRoleMutation(), {
      wrapper: wrapper(queryClient),
    });
    const body: components['schemas']['CreateRoleDto'] = {
      companyId: '6f1d3c1e-0000-4000-8000-000000000000',
      slug: 'clerk',
      name: 'Clerk',
      description: 'Files things',
      knowledgeDomains: [],
      mcpServerList: [],
    };
    let created;
    await act(async () => {
      created = await result.current.mutateAsync(body);
    });

    const request = requestMade();
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/api/role');
    expect(await request.json()).toEqual(body);
    expect(created).toEqual({
      role: { id: 'r1', name: 'Clerk' },
      warnings: ['no café'],
    });
  });

  it('useUpdateRoleMutation PUTs /api/role/{id}', async () => {
    respondWith({ id: 'r1', name: 'Clerk' });

    const { result } = renderHook(() => useUpdateRoleMutation(), {
      wrapper: wrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({ id: 'r1', body: { name: 'Clerk' } });
    });

    const request = requestMade();
    expect(request.method).toBe('PUT');
    expect(new URL(request.url).pathname).toBe('/api/role/r1');
  });

  it('useUpdateCompanyMutation PUTs /api/company/{id}, and can clear a model', async () => {
    respondWith({ id: 'c1', llmConfig: null });

    const { result } = renderHook(() => useUpdateCompanyMutation(), {
      wrapper: wrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        id: 'c1',
        body: { llmConfig: null },
      });
    });

    const request = requestMade();
    expect(request.method).toBe('PUT');
    expect(new URL(request.url).pathname).toBe('/api/company/c1');
    expect(await request.json()).toEqual({ llmConfig: null });
  });

  it('useCreateCompanyMutation POSTs /api/company without asking to replace', async () => {
    respondWith({ id: 'c1', slug: 'acme' });

    const { result } = renderHook(() => useCreateCompanyMutation(), {
      wrapper: wrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync({
        slug: 'acme',
        name: 'Acme',
        description: 'Makes things',
      });
    });

    const request = requestMade();
    expect(request.method).toBe('POST');
    const url = new URL(request.url);
    expect(url.pathname).toBe('/api/company');
    expect(url.search).toBe('');
  });

  it('useCreateCompanyMutation surfaces a taken slug as a 409 ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          message: "A company with slug 'acme' already exists.",
        }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { result } = renderHook(() => useCreateCompanyMutation(), {
      wrapper: wrapper(queryClient),
    });
    const error: unknown = await result.current
      .mutateAsync({ slug: 'acme', name: 'Acme', description: 'd' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error instanceof ApiError && error.status).toBe(409);
  });

  it('useDeleteCompanyMutation DELETEs /api/company/{id}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const { result } = renderHook(() => useDeleteCompanyMutation(), {
      wrapper: wrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync('c1');
    });

    const request = requestMade();
    expect(request.method).toBe('DELETE');
    expect(new URL(request.url).pathname).toBe('/api/company/c1');
  });

  it('useDeleteRoleMutation DELETEs /api/role/{id}', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    const { result } = renderHook(() => useDeleteRoleMutation(), {
      wrapper: wrapper(queryClient),
    });
    await act(async () => {
      await result.current.mutateAsync('r1');
    });

    const request = requestMade();
    expect(request.method).toBe('DELETE');
    expect(new URL(request.url).pathname).toBe('/api/role/r1');
  });

  it.each([
    [
      'role',
      { kind: 'role', roleId: 'r1' } as const,
      '/api/role/r1/knowledge/a.md',
    ],
    [
      'company',
      { kind: 'company', companyId: 'c1' } as const,
      '/api/company/c1/knowledge/a.md',
    ],
  ])(
    'useDeleteKnowledgeMutation hits the %s route',
    async (_name, scope, path) => {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

      const { result } = renderHook(() => useDeleteKnowledgeMutation(scope), {
        wrapper: wrapper(queryClient),
      });
      await act(async () => {
        await result.current.mutateAsync('a.md');
      });

      const request = requestMade();
      expect(request.method).toBe('DELETE');
      expect(new URL(request.url).pathname).toBe(path);
    },
  );

  it.each([
    [
      'role',
      { kind: 'role', roleId: 'r1' } as const,
      '/api/role/r1/knowledge/reindex',
    ],
    [
      'company',
      { kind: 'company', companyId: 'c1' } as const,
      '/api/company/c1/knowledge/reindex',
    ],
  ])(
    'useReindexKnowledgeMutation hits the %s route',
    async (_name, scope, path) => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ reindexing: true }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const { result } = renderHook(() => useReindexKnowledgeMutation(scope), {
        wrapper: wrapper(queryClient),
      });
      await act(async () => {
        await result.current.mutateAsync();
      });

      const request = requestMade();
      expect(request.method).toBe('POST');
      expect(new URL(request.url).pathname).toBe(path);
    },
  );
});
