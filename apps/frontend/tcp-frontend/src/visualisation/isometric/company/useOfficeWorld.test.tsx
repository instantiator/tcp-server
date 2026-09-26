import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { WireEvent } from '@tcp/shared/client';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentDTO,
  AssignmentDTO,
  RoleDTO,
  TaskDTO,
} from '../../../api/dtos';
import { applyEvent } from '../../../events/cache';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { taskRoomId } from './world/layout';
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

/**
 * Drives the real hook — snapshot, reducer and rules together — through one
 * agent's whole life in a task, over the same `applyEvent` path a live
 * event stream uses. The browser tier has no LLM to run a real agent against
 * (see the plan's decision 1), so this is the agreed stand-in for agent
 * end-to-end coverage: `CompanyActivity.test.tsx` drives `applyEvent` the same
 * way for its own live-event tests, and this mirrors that pattern here.
 */
describe('useOfficeWorld — the live pipeline (agent E2E stand-in)', () => {
  const COMPANY_ID = 'company-1';
  const TASK_ID = 'task-1';
  const ASSIGNMENT_ID = 'assignment-1';
  const AGENT_ID = 'g1';
  const NOW = '2026-09-26T00:00:00.000Z';

  const ROLE: RoleDTO = {
    id: 'role-1',
    companyId: COMPANY_ID,
    slug: 'engineer',
    name: 'Engineer',
    description: 'Writes the code',
    knowledgeDomains: [],
    mcpServerList: [],
    queryIndex: 0,
  };

  const task = (overrides: { status: TaskDTO['status'] }): TaskDTO => ({
    id: TASK_ID,
    companyId: COMPANY_ID,
    request: 'Reticulate the splines',
    shortcode: 'TASK-1',
    status: overrides.status,
    materials: [],
    expected: [],
    completed: null,
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const assignment = (overrides: {
    status: AssignmentDTO['status'];
  }): AssignmentDTO => ({
    id: ASSIGNMENT_ID,
    taskId: TASK_ID,
    companyId: COMPANY_ID,
    mode: 'implement',
    orderIndex: 0,
    prompt: 'Implement the thing',
    roleId: ROLE.id,
    status: overrides.status,
    failureReason: null,
    agentId: AGENT_ID,
    targetAssignmentId: null,
    parentAssignmentId: null,
    materials: [],
    expected: [],
    prepared: [],
    approved: [],
    summary: null,
    qaStatus: null,
    qaFeedback: null,
    qaAttempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const agent = (overrides: { status: AgentDTO['status'] }): AgentDTO => ({
    id: AGENT_ID,
    companyId: COMPANY_ID,
    roleId: ROLE.id,
    assignmentId: ASSIGNMENT_ID,
    status: overrides.status,
    threadId: null,
    initialPrompt: 'Do the thing',
    createdAt: NOW,
    updatedAt: NOW,
    output: null,
  });

  /** A `state_change` audit event, as `useEventStream` hands to `applyEvent`. */
  const auditEvent = (
    payload: Record<string, unknown>,
    agentId: string | null,
    taskId: string | null,
  ): WireEvent => ({
    type: 'audit',
    event: {
      timestamp: NOW,
      companyId: COMPANY_ID,
      role: 'system',
      agentId,
      assignmentId: null,
      taskId,
      eventType: 'state_change',
      payload,
    },
  });

  /** A `TaskChangeSummary`, built from the fixture task it patches. */
  const taskSummary = (overrides: { status: TaskDTO['status'] }) => ({
    id: TASK_ID,
    status: overrides.status,
    request: 'Reticulate the splines',
    shortcode: 'TASK-1',
    createdAt: NOW,
    updatedAt: NOW,
    completedSteps: 0,
    totalSteps: 0,
  });

  const renderWithClient = () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return {
      queryClient,
      ...renderHook(() => useOfficeWorld(COMPANY_ID), { wrapper }),
    };
  };

  beforeEach(() => {
    installFetchMock();
    respondByRoute([
      [ROLES_ROUTE, { body: [ROLE] }],
      [AGENTS_ROUTE, { body: [agent({ status: 'idle' })] }],
      [TASKS_ROUTE, { body: [task({ status: 'in-progress' })] }],
      [ASSIGNMENTS_ROUTE, { body: [assignment({ status: 'in-progress' })] }],
      [CONVERSATIONS_ROUTE, { body: [] }],
    ]);
  });

  it('walks one agent from its desk to the whiteboard, back to its desk, and out through a cancelled task', async () => {
    const { result, queryClient } = renderWithClient();

    // Initial load: a task room opens, and the agent's avatar is placed
    // straight at its desk rather than walked in — `placeAtTarget` is only
    // true on the very first snapshot.
    await waitFor(() => {
      expect(
        result.current.world.avatars.some((avatar) => avatar.kind === 'agent'),
      ).toBe(true);
    });

    const initial = result.current.world.avatars.find(
      (avatar) => avatar.kind === 'agent',
    );
    if (initial === undefined) throw new Error('expected an agent avatar');
    const avatarId = initial.id;
    const deskId = initial.deskId;
    expect(initial.agentId).toBe(AGENT_ID);
    expect(deskId).not.toBeNull();
    expect(initial.target).toEqual({ kind: 'furniture', furnitureId: deskId });
    expect(initial.placeAtTarget).toBe(true);
    expect(
      result.current.world.rooms.some((room) => room.purpose === 'task'),
    ).toBe(true);

    // The agent starts running: the whiteboard replaces the desk as its target.
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'running' }, AGENT_ID, null),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === avatarId,
      );
      expect(avatar?.target).toEqual({
        kind: 'furniture',
        furnitureId: `${taskRoomId(TASK_ID)}:whiteboard`,
      });
    });

    // The agent completes: its avatar is dissociated but keeps its desk.
    act(() => {
      applyEvent(
        queryClient,
        auditEvent({ entity: 'agent', newStatus: 'completed' }, AGENT_ID, null),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === avatarId,
      );
      expect(avatar?.agentId).toBeNull();
      expect(avatar?.deskId).toBe(deskId);
      expect(avatar?.target).toEqual({
        kind: 'furniture',
        furnitureId: deskId,
      });
    });

    // The task is cancelled: the room starts closing and the avatar heads out.
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'task', summary: taskSummary({ status: 'cancelled' }) },
          null,
          TASK_ID,
        ),
      );
    });
    await waitFor(() => {
      const room = result.current.world.rooms.find((r) => r.purpose === 'task');
      expect(room?.closing).toBe(true);
      const avatar = result.current.world.avatars.find(
        (a) => a.id === avatarId,
      );
      expect(avatar?.target).toEqual({ kind: 'exit' });
    });

    // The scene reports the avatar has left: it disappears, and — with
    // nobody left holding the task — its room is removed too.
    act(() => {
      result.current.avatarExited(avatarId);
    });
    await waitFor(() => {
      expect(result.current.world.avatars.some((a) => a.id === avatarId)).toBe(
        false,
      );
      expect(
        result.current.world.rooms.some((room) => room.purpose === 'task'),
      ).toBe(false);
    });
  });
});
