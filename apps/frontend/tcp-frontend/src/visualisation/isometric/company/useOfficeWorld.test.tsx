import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { useOfficeWorld } from './useOfficeWorld';

// `phaser` is mocked globally in `test-setup.ts`, but this hook never
// touches Phaser at all — it only builds the office model that the scene
// later draws, so nothing here depends on that mock.

const ROLES_ROUTE = /\/api\/company\/[^/]+\/roles/;
const AGENTS_ROUTE = /\/api\/agent\?/;
const TASKS_ROUTE = /\/api\/task\?/;
const ASSIGNMENTS_ROUTE = /\/api\/assignment\?/;
const CONVERSATIONS_ROUTE = /\/api\/conversation\?/;

const ROLES = [
  { id: 'role-1', name: 'Engineer' },
  { id: 'role-2', name: 'Reviewer' },
];

const renderOfficeWorld = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useOfficeWorld('company-1'), { wrapper });
};

describe('useOfficeWorld', () => {
  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [ROLES_ROUTE, { body: ROLES }],
      [AGENTS_ROUTE, { body: [] }],
      [TASKS_ROUTE, { body: [] }],
      [ASSIGNMENTS_ROUTE, { body: [] }],
      [CONVERSATIONS_ROUTE, { body: [] }],
    ]);
  });

  it('starts at the initial world, with no avatars and no snapshot, before data arrives', () => {
    const { result } = renderOfficeWorld();

    expect(result.current.world.avatars).toHaveLength(0);
    expect(result.current.snapshot).toBeNull();
  });

  it('places one role avatar per role once the company data has loaded', async () => {
    const { result } = renderOfficeWorld();

    await waitFor(() => {
      expect(result.current.snapshot?.roles).toHaveLength(2);
    });

    expect(
      result.current.world.avatars.filter((avatar) => avatar.kind === 'role'),
    ).toHaveLength(2);
  });
});
