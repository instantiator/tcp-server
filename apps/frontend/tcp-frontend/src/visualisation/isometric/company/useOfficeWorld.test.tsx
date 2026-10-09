import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { WireEvent } from '@tcp/shared/client';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentDTO,
  AssignmentDTO,
  RoleDTO,
  TaskDTO,
} from '../../../api/dtos';
import { announce } from '../../../announce/announcer';
import { applyEvent } from '../../../events/cache';
import {
  installFetchMock,
  respondByRoute,
} from '../../../test-support/fetch-mock';
import { ARCHIVE_BOOKSHELF_ID, taskRoomId } from './world/layout';
import { useOfficeWorld } from './useOfficeWorld';

// A spy over the real announcer, so the walks below can prove the office
// says nothing as avatars move (ADR-027's canvas rule: movement is decoration,
// and the Activity tab is the browsable equivalent).
vi.mock('../../../announce/announcer', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../announce/announcer')>();
  return { ...actual, announce: vi.fn(actual.announce) };
});

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
 * end-to-end coverage: `CompanyTabs.test.tsx` drives `applyEvent` the same
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
    spendCapExempt: false,
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
    rateLimitRetries: 0,
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
  const taskSummary = (overrides: {
    status: TaskDTO['status'];
    visualisationClosedAt?: string;
  }) => ({
    id: TASK_ID,
    status: overrides.status,
    visualisationClosedAt: overrides.visualisationClosedAt,
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

  it('walks one agent from waiting in the rec room to the whiteboard, back to its desk, and out through a cancelled task', async () => {
    const { result, queryClient } = renderWithClient();

    // Initial load: a task room opens, and the agent's avatar is placed
    // straight at its role's book in the rec room rather than walked in —
    // `placeAtTarget` is only true on the very first snapshot. The fixture
    // agent is `idle` on an `in-progress` assignment, decision 4's "waiting
    // to start" (002.02 stage 4), not the desk a finished or paused agent
    // waits at.
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
    expect(initial.target).toEqual({
      kind: 'avatar',
      avatarId: `role:${ROLE.id}`,
    });
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

    // The task is cancelled: the avatar heads out, and the room stays open.
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
      expect(room?.closing).toBe(false);
      const avatar = result.current.world.avatars.find(
        (a) => a.id === avatarId,
      );
      expect(avatar?.target).toEqual({ kind: 'exit' });
    });

    // The scene reports the avatar has left: it disappears, and the empty
    // room stays until the user closes it.
    act(() => {
      result.current.avatarExited(avatarId);
    });
    await waitFor(() => {
      expect(result.current.world.avatars.some((a) => a.id === avatarId)).toBe(
        false,
      );
    });
    expect(
      result.current.world.rooms.some((room) => room.purpose === 'task'),
    ).toBe(true);

    // Closing the room removes it, with nobody left holding the task.
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'task',
            summary: taskSummary({
              status: 'cancelled',
              visualisationClosedAt: NOW,
            }),
          },
          null,
          TASK_ID,
        ),
      );
    });
    await waitFor(() => {
      expect(
        result.current.world.rooms.some((room) => room.purpose === 'task'),
      ).toBe(false);
    });
  });

  it("walks a live agent added after the first snapshot through its role's pickup, then waits at the role book alongside it", async () => {
    const AGENT_2_ID = 'g2';
    const ASSIGNMENT_2_ID = 'assignment-2';
    // Both assignments are loaded from the start — 002.01's pickup rule
    // works off the office model, not the fetch order, and only the agent
    // list gets a live update below, so the new agent's assignment has to
    // already be there for `buildCompanySnapshot` to pick it up.
    const assignment2: AssignmentDTO = {
      ...assignment({ status: 'in-progress' }),
      id: ASSIGNMENT_2_ID,
      agentId: AGENT_2_ID,
    };
    const agent2 = (overrides: { status: AgentDTO['status'] }): AgentDTO => ({
      ...agent(overrides),
      id: AGENT_2_ID,
      assignmentId: ASSIGNMENT_2_ID,
    });

    respondByRoute([
      [ROLES_ROUTE, { body: [ROLE] }],
      [AGENTS_ROUTE, { body: [agent({ status: 'idle' })] }],
      [TASKS_ROUTE, { body: [task({ status: 'in-progress' })] }],
      [
        ASSIGNMENTS_ROUTE,
        { body: [assignment({ status: 'in-progress' }), assignment2] },
      ],
      [CONVERSATIONS_ROUTE, { body: [] }],
    ]);

    const { result, queryClient } = renderWithClient();

    // Initial load: agent-1 lands straight at its role's book, as the
    // previous test covers — `placeAtTarget` and `hasRole` both start true,
    // but it's still `idle` on an `in-progress` assignment.
    await waitFor(() => {
      expect(
        result.current.world.avatars.some((avatar) => avatar.kind === 'agent'),
      ).toBe(true);
    });

    // A second agent of the same role joins live. Its `state_change` carries
    // a full summary — `cache.ts` has no cached row for its id, so it
    // invalidates the agents list rather than patching one in place, and the
    // list refetch below is what actually adds it to the snapshot.
    respondByRoute([
      [ROLES_ROUTE, { body: [ROLE] }],
      [
        AGENTS_ROUTE,
        { body: [agent({ status: 'idle' }), agent2({ status: 'idle' })] },
      ],
      [TASKS_ROUTE, { body: [task({ status: 'in-progress' })] }],
      [
        ASSIGNMENTS_ROUTE,
        { body: [assignment({ status: 'in-progress' }), assignment2] },
      ],
      [CONVERSATIONS_ROUTE, { body: [] }],
    ]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            summary: {
              id: AGENT_2_ID,
              status: 'idle',
              roleId: ROLE.id,
              assignmentId: ASSIGNMENT_2_ID,
            },
          },
          AGENT_2_ID,
          null,
        ),
      );
    });

    // It joined after the first snapshot, so it hasn't collected its role
    // yet: it heads for the role avatar first, not straight to a desk.
    let secondAvatarId = '';
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.kind === 'agent' && a.agentId === AGENT_2_ID,
      );
      if (avatar === undefined) throw new Error('expected the second avatar');
      secondAvatarId = avatar.id;
      expect(avatar.hasRole).toBe(false);
      expect(avatar.target).toEqual({
        kind: 'avatar',
        avatarId: `role:${ROLE.id}`,
      });
    });

    // The scene reports it reached the role avatar: `hasRole` flips, but the
    // agent is still `waiting` (idle, in-progress, not chat — decision 4), so
    // the rules leave it right where it is rather than sending it on to its
    // desk.
    act(() => {
      result.current.avatarArrived(secondAvatarId, { x: 0, y: 0 });
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === secondAvatarId,
      );
      expect(avatar?.hasRole).toBe(true);
      expect(avatar?.deskId).not.toBeNull();
      expect(avatar?.target).toEqual({
        kind: 'avatar',
        avatarId: `role:${ROLE.id}`,
      });
    });
  });

  /**
   * Table-driven: walks one task's whole lifecycle — a planner, a worker and
   * a QA reviewer, each in its own role — asserting the avatar's target and
   * the snapshot's activity after every step (002.02 stage 4). Every
   * assignment is dispatched from the start — as the previous test notes,
   * the pickup rule works off the office model, not fetch order — but the
   * task itself doesn't exist until row 2, so row 1 has nothing to show.
   * Agent-creation events carry a summary throughout, as stage 2 made every
   * writer do; a plain status change alternates with and without one, to
   * prove `cache.ts`'s `synthesiseAgentPatch` fallback still works.
   */
  it('walks a task through planner, worker and QA — waiting, working, and out', async () => {
    const ROLE_PLANNER: RoleDTO = {
      id: 'role-planner',
      companyId: COMPANY_ID,
      slug: 'planner',
      name: 'Planner',
      description: 'Plans the work',
      knowledgeDomains: [],
      mcpServerList: [],
      queryIndex: 0,
    };
    const ROLE_WORKER: RoleDTO = {
      ...ROLE_PLANNER,
      id: 'role-worker',
      slug: 'worker',
      name: 'Worker',
      description: 'Does the work',
    };
    const ROLE_QA: RoleDTO = {
      ...ROLE_PLANNER,
      id: 'role-qa',
      slug: 'qa',
      name: 'Reviewer',
      description: 'Reviews the work',
    };
    const ROLES3 = [ROLE_PLANNER, ROLE_WORKER, ROLE_QA];

    const PLAN_ASSIGNMENT_ID = 'assignment-plan';
    const IMPLEMENT_ASSIGNMENT_ID = 'assignment-implement';
    const QA_ASSIGNMENT_ID = 'assignment-qa';
    const PLANNER_AGENT_ID = 'agent-planner';
    const WORKER_AGENT_ID = 'agent-worker';
    const QA_AGENT_ID = 'agent-qa';

    const allAssignments: AssignmentDTO[] = [
      {
        ...assignment({ status: 'in-progress' }),
        id: PLAN_ASSIGNMENT_ID,
        mode: 'plan',
        roleId: ROLE_PLANNER.id,
      },
      {
        ...assignment({ status: 'in-progress' }),
        id: IMPLEMENT_ASSIGNMENT_ID,
        mode: 'implement',
        roleId: ROLE_WORKER.id,
      },
      {
        ...assignment({ status: 'in-progress' }),
        id: QA_ASSIGNMENT_ID,
        mode: 'qa',
        roleId: ROLE_QA.id,
        targetAssignmentId: IMPLEMENT_ASSIGNMENT_ID,
      },
    ];

    const plannerAgent = (status: AgentDTO['status']): AgentDTO => ({
      ...agent({ status }),
      id: PLANNER_AGENT_ID,
      roleId: ROLE_PLANNER.id,
      assignmentId: PLAN_ASSIGNMENT_ID,
    });
    const workerAgent = (status: AgentDTO['status']): AgentDTO => ({
      ...agent({ status }),
      id: WORKER_AGENT_ID,
      roleId: ROLE_WORKER.id,
      assignmentId: IMPLEMENT_ASSIGNMENT_ID,
    });
    const qaAgent = (status: AgentDTO['status']): AgentDTO => ({
      ...agent({ status }),
      id: QA_AGENT_ID,
      roleId: ROLE_QA.id,
      assignmentId: QA_ASSIGNMENT_ID,
    });

    /** Re-answers every route; only tasks and agents change row to row. */
    const setCompany = (tasks: TaskDTO[], agents: AgentDTO[]): void => {
      respondByRoute([
        [ROLES_ROUTE, { body: ROLES3 }],
        [AGENTS_ROUTE, { body: agents }],
        [TASKS_ROUTE, { body: tasks }],
        [ASSIGNMENTS_ROUTE, { body: allAssignments }],
        [CONVERSATIONS_ROUTE, { body: [] }],
      ]);
    };

    // Row 1 — ready: no task exists yet, so there's no room and no avatar,
    // even though every assignment is already sitting in the DB.
    setCompany([], []);
    const { result, queryClient } = renderWithClient();
    await waitFor(() => {
      expect(result.current.snapshot?.roles).toHaveLength(3);
    });
    expect(result.current.world.rooms.some((r) => r.purpose === 'task')).toBe(
      false,
    );
    expect(result.current.world.avatars.some((a) => a.kind === 'agent')).toBe(
      false,
    );

    // Row 2 — planning: the planner's agent is created `idle`, with a
    // summary, so it waits by its own role's book (decision 4).
    setCompany([task({ status: 'planning' })], [plannerAgent('idle')]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'task', summary: taskSummary({ status: 'planning' }) },
          null,
          TASK_ID,
        ),
      );
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            summary: {
              id: PLANNER_AGENT_ID,
              status: 'idle',
              roleId: ROLE_PLANNER.id,
              assignmentId: PLAN_ASSIGNMENT_ID,
            },
          },
          PLANNER_AGENT_ID,
          TASK_ID,
        ),
      );
    });
    let plannerAvatarId = '';
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.kind === 'agent' && a.agentId === PLANNER_AGENT_ID,
      );
      if (avatar === undefined) throw new Error('expected the planner avatar');
      plannerAvatarId = avatar.id;
      expect(avatar.target).toEqual({
        kind: 'avatar',
        avatarId: `role:${ROLE_PLANNER.id}`,
      });
    });
    expect(
      result.current.snapshot?.agents.find((a) => a.id === PLANNER_AGENT_ID)
        ?.activity.kind,
    ).toBe('waiting');

    // Live-added avatars start without their role (002.01's pickup rule);
    // the scene reports arrival at the role book it was already heading
    // for. `hasRole` flips, and — still `waiting` — the target doesn't move.
    act(() => {
      result.current.avatarArrived(plannerAvatarId, { x: 0, y: 0 });
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === plannerAvatarId,
      );
      expect(avatar?.hasRole).toBe(true);
    });

    // Row 3 — the planner starts: no summary this time, the shape
    // tcp-agent's own `running` write still sends — `cache.ts` rebuilds the
    // patch itself via `synthesiseAgentPatch`. The whiteboard replaces the
    // role book.
    setCompany([task({ status: 'planning' })], [plannerAgent('running')]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'agent', newStatus: 'running' },
          PLANNER_AGENT_ID,
          null,
        ),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === plannerAvatarId,
      );
      expect(avatar?.target).toEqual({
        kind: 'furniture',
        furnitureId: `${taskRoomId(TASK_ID)}:whiteboard`,
      });
    });
    expect(
      result.current.snapshot?.agents.find((a) => a.id === PLANNER_AGENT_ID)
        ?.activity,
    ).toEqual({ kind: 'working' });

    // Row 4 — the planner completes: dissociated, back at its own desk.
    setCompany([task({ status: 'planning' })], [plannerAgent('completed')]);
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'agent', newStatus: 'completed' },
          PLANNER_AGENT_ID,
          null,
        ),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === plannerAvatarId,
      );
      expect(avatar?.agentId).toBeNull();
      expect(avatar?.deskId).not.toBeNull();
      expect(avatar?.target).toEqual({
        kind: 'furniture',
        furnitureId: avatar?.deskId,
      });
    });

    // Row 5 — the plan is in: the task moves to `in-progress`, and the
    // worker's agent is created `idle` — waiting by its own role's book,
    // not the planner's, and not the desk it will later work at.
    setCompany(
      [task({ status: 'in-progress' })],
      [plannerAgent('completed'), workerAgent('idle')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'task', summary: taskSummary({ status: 'in-progress' }) },
          null,
          TASK_ID,
        ),
      );
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            summary: {
              id: WORKER_AGENT_ID,
              status: 'idle',
              roleId: ROLE_WORKER.id,
              assignmentId: IMPLEMENT_ASSIGNMENT_ID,
            },
          },
          WORKER_AGENT_ID,
          TASK_ID,
        ),
      );
    });
    let workerAvatarId = '';
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.kind === 'agent' && a.agentId === WORKER_AGENT_ID,
      );
      if (avatar === undefined) throw new Error('expected the worker avatar');
      workerAvatarId = avatar.id;
      expect(avatar.target).toEqual({
        kind: 'avatar',
        avatarId: `role:${ROLE_WORKER.id}`,
      });
    });
    expect(
      result.current.snapshot?.agents.find((a) => a.id === WORKER_AGENT_ID)
        ?.activity.kind,
    ).toBe('waiting');

    // The scene reports arrival at the role book, same as the planner above.
    act(() => {
      result.current.avatarArrived(workerAvatarId, { x: 0, y: 0 });
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === workerAvatarId,
      );
      expect(avatar?.hasRole).toBe(true);
    });

    // Row 5, continued — the worker starts: the whiteboard replaces the
    // role book, exactly as the planner's did in row 3.
    setCompany(
      [task({ status: 'in-progress' })],
      [plannerAgent('completed'), workerAgent('running')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'agent', newStatus: 'running' },
          WORKER_AGENT_ID,
          null,
        ),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === workerAvatarId,
      );
      expect(avatar?.target).toEqual({
        kind: 'furniture',
        furnitureId: `${taskRoomId(TASK_ID)}:whiteboard`,
      });
    });

    // Row 6 — the worker pauses for QA hand-off: it waits at its own desk.
    // With a summary this time — stage 2 makes the hand-off publish one too.
    setCompany(
      [task({ status: 'in-progress' })],
      [plannerAgent('completed'), workerAgent('paused')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            summary: {
              id: WORKER_AGENT_ID,
              status: 'paused',
              roleId: ROLE_WORKER.id,
              assignmentId: IMPLEMENT_ASSIGNMENT_ID,
            },
          },
          WORKER_AGENT_ID,
          null,
        ),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === workerAvatarId,
      );
      expect(avatar?.target).toEqual({
        kind: 'furniture',
        furnitureId: avatar?.deskId,
      });
    });
    expect(
      result.current.snapshot?.agents.find((a) => a.id === WORKER_AGENT_ID)
        ?.activity,
    ).toEqual({ kind: 'atDesk' });

    // Row 7 — the reviewer arrives: created `idle`, waiting by its own role's
    // book like the planner and the worker before it (rows 2 and 5).
    setCompany(
      [task({ status: 'in-progress' })],
      [plannerAgent('completed'), workerAgent('paused'), qaAgent('idle')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'agent',
            summary: {
              id: QA_AGENT_ID,
              status: 'idle',
              roleId: ROLE_QA.id,
              assignmentId: QA_ASSIGNMENT_ID,
            },
          },
          QA_AGENT_ID,
          TASK_ID,
        ),
      );
    });
    let qaAvatarId = '';
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.kind === 'agent' && a.agentId === QA_AGENT_ID,
      );
      if (avatar === undefined) throw new Error('expected the QA avatar');
      qaAvatarId = avatar.id;
      expect(avatar.target).toEqual({
        kind: 'avatar',
        avatarId: `role:${ROLE_QA.id}`,
      });
    });
    act(() => {
      result.current.avatarArrived(qaAvatarId, { x: 0, y: 0 });
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === qaAvatarId,
      );
      expect(avatar?.hasRole).toBe(true);
    });

    // Row 7, continued — the reviewer starts, no summary this time, and
    // reviews the worker directly — the avatar it targets, not the
    // whiteboard.
    setCompany(
      [task({ status: 'in-progress' })],
      [plannerAgent('completed'), workerAgent('paused'), qaAgent('running')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'agent', newStatus: 'running' },
          QA_AGENT_ID,
          null,
        ),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === qaAvatarId,
      );
      expect(avatar?.target).toEqual({
        kind: 'avatar',
        avatarId: workerAvatarId,
      });
    });
    expect(
      result.current.snapshot?.agents.find((a) => a.id === QA_AGENT_ID)
        ?.activity,
    ).toEqual({
      kind: 'reviewing',
      reviewedAssignmentId: IMPLEMENT_ASSIGNMENT_ID,
    });

    // Row 8 — finalising: not finished yet, so the room stays open.
    setCompany(
      [task({ status: 'finalising' })],
      [plannerAgent('completed'), workerAgent('paused'), qaAgent('running')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'task', summary: taskSummary({ status: 'finalising' }) },
          null,
          TASK_ID,
        ),
      );
    });
    await waitFor(() => {
      expect(
        result.current.snapshot?.tasks.find((t) => t.id === TASK_ID)?.finished,
      ).toBe(false);
      expect(result.current.world.rooms.some((r) => r.purpose === 'task')).toBe(
        true,
      );
    });

    // Row 8, continued — the reviewer finishes too, after the planner:
    // dissociating stamps a higher `dissociatedSeq` than the planner's own
    // (row 4), so when the task later succeeds, the QA avatar — not the
    // planner's, despite dissociating first — carries the outputs out.
    setCompany(
      [task({ status: 'finalising' })],
      [plannerAgent('completed'), workerAgent('paused'), qaAgent('completed')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'agent', newStatus: 'completed' },
          QA_AGENT_ID,
          null,
        ),
      );
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === qaAvatarId,
      );
      expect(avatar?.agentId).toBeNull();
    });

    // Row 9 — succeeded: the room stays open. The planner and worker —
    // neither the most recently dissociated — head for the exit; the QA
    // avatar, the last to let go of its agent, carries the task's outputs to
    // the archive bookshelf instead.
    setCompany(
      [task({ status: 'succeeded' })],
      [plannerAgent('completed'), workerAgent('paused'), qaAgent('completed')],
    );
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          { entity: 'task', summary: taskSummary({ status: 'succeeded' }) },
          null,
          TASK_ID,
        ),
      );
    });
    await waitFor(() => {
      const room = result.current.world.rooms.find((r) => r.purpose === 'task');
      expect(room?.closing).toBe(false);
      for (const id of [plannerAvatarId, workerAvatarId]) {
        const avatar = result.current.world.avatars.find((a) => a.id === id);
        expect(avatar?.target).toEqual({ kind: 'exit' });
      }
      const carrier = result.current.world.avatars.find(
        (a) => a.id === qaAvatarId,
      );
      expect(carrier?.carrying).toBe('outputs');
      expect(carrier?.target).toEqual({
        kind: 'furniture',
        furnitureId: ARCHIVE_BOOKSHELF_ID,
      });
    });

    // The scene reports the carrier has reached the bookshelf: it lets go of
    // the outputs and heads for the exit like everyone else.
    const bookshelf = result.current.world.furniture.find(
      (item) => item.id === ARCHIVE_BOOKSHELF_ID,
    );
    if (bookshelf === undefined) throw new Error('expected the bookshelf');
    act(() => {
      result.current.avatarArrived(qaAvatarId, bookshelf.tile);
    });
    await waitFor(() => {
      const avatar = result.current.world.avatars.find(
        (a) => a.id === qaAvatarId,
      );
      expect(avatar?.carrying).toBeNull();
      expect(avatar?.target).toEqual({ kind: 'exit' });
    });

    // The scene reports every avatar has left: they disappear, and the empty
    // room stays until the user closes it.
    act(() => {
      result.current.avatarExited(plannerAvatarId);
      result.current.avatarExited(workerAvatarId);
      result.current.avatarExited(qaAvatarId);
    });
    await waitFor(() => {
      const ids = [plannerAvatarId, workerAvatarId, qaAvatarId];
      expect(result.current.world.avatars.some((a) => ids.includes(a.id))).toBe(
        false,
      );
    });
    expect(
      result.current.world.rooms.some((room) => room.purpose === 'task'),
    ).toBe(true);

    // Closing the room removes it.
    act(() => {
      applyEvent(
        queryClient,
        auditEvent(
          {
            entity: 'task',
            summary: taskSummary({
              status: 'succeeded',
              visualisationClosedAt: NOW,
            }),
          },
          null,
          TASK_ID,
        ),
      );
    });
    await waitFor(() => {
      expect(
        result.current.world.rooms.some((room) => room.purpose === 'task'),
      ).toBe(false);
    });

    // Waiting, working, carrying to the archive and leaving: none of it is
    // announced.
    expect(announce).not.toHaveBeenCalled();
  });
});
