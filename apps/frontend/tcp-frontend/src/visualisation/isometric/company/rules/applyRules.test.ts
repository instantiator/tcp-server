import { describe, expect, it } from 'vitest';

import {
  createInitialWorld,
  oneToOneRoomId,
  taskRoomId,
} from '../world/layout';
import {
  createInitialOfficeState,
  officeReducer,
} from '../world/officeReducer';
import type { Avatar, OfficeWorld } from '../world/types';
import { avatarById, furnitureById, roomById } from '../world/worldOps';
import { applyRules } from './applyRules';
import type { CompanySnapshot, SnapshotTask } from './companySnapshot';

function snapshot(): CompanySnapshot {
  return { roles: [{ id: 'a', name: 'Role A' }], tasks: [], agents: [] };
}

function taskSnap(overrides: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    id: 'task-1',
    shortcode: 'T1',
    request: 'Do the thing',
    finished: false,
    step: 0,
    steps: 0,
    ...overrides,
  };
}

function requireAvatar(
  world: OfficeWorld,
  predicate: (avatar: Avatar) => boolean,
): Avatar {
  const found = world.avatars.find(predicate);
  if (found === undefined) {
    throw new Error('expected to find a matching avatar');
  }
  return found;
}

describe('applyRules', () => {
  it('runs roleRules: a role in the snapshot gets a role avatar', () => {
    const world = applyRules(createInitialWorld(), snapshot(), {
      firstSnapshot: true,
    });
    expect(avatarById(world, 'role:a')).toBeDefined();
  });

  it('is reference-stable when the rules make no further change', () => {
    const world = applyRules(createInitialWorld(), snapshot(), {
      firstSnapshot: true,
    });
    const again = applyRules(world, snapshot(), { firstSnapshot: false });
    expect(again).toBe(world);
  });
});

describe('a full task lifecycle', () => {
  it('walks a task from planning through QA to its room disappearing', () => {
    const roomId = taskRoomId('task-1');
    let state = createInitialOfficeState();

    // A planning agent starts the task.
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap()],
        agents: [
          {
            id: 'planner-1',
            roleId: 'planner-role',
            assignmentId: 'plan-assignment',
            taskId: 'task-1',
            activity: { kind: 'working' },
          },
        ],
      },
    });
    expect(roomById(state.world, roomId)).toBeDefined();
    const planner = requireAvatar(
      state.world,
      (a) => a.agentId === 'planner-1',
    );
    expect(planner.target).toEqual({
      kind: 'furniture',
      furnitureId: `${roomId}:whiteboard`,
    });

    // The plan is done; an implement agent picks the task up.
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap()],
        agents: [
          {
            id: 'planner-1',
            roleId: 'planner-role',
            assignmentId: 'plan-assignment',
            taskId: 'task-1',
            activity: { kind: 'finished' },
          },
          {
            id: 'implementer-1',
            roleId: 'implementer-role',
            assignmentId: 'impl-assignment',
            taskId: 'task-1',
            activity: { kind: 'working' },
          },
        ],
      },
    });
    const plannerAfter = requireAvatar(state.world, (a) => a.id === planner.id);
    expect(plannerAfter.agentId).toBeNull(); // waits at its desk; not reused (different role)
    const implementer = requireAvatar(
      state.world,
      (a) => a.agentId === 'implementer-1',
    );
    expect(implementer.target).toEqual({
      kind: 'furniture',
      furnitureId: `${roomId}:whiteboard`,
    });

    // QA reviews the implementer's work.
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap()],
        agents: [
          {
            id: 'planner-1',
            roleId: 'planner-role',
            assignmentId: 'plan-assignment',
            taskId: 'task-1',
            activity: { kind: 'finished' },
          },
          {
            id: 'implementer-1',
            roleId: 'implementer-role',
            assignmentId: 'impl-assignment',
            taskId: 'task-1',
            activity: { kind: 'atDesk' },
          },
          {
            id: 'qa-1',
            roleId: 'qa-role',
            assignmentId: 'qa-assignment',
            taskId: 'task-1',
            activity: {
              kind: 'reviewing',
              reviewedAssignmentId: 'impl-assignment',
            },
          },
        ],
      },
    });
    const implementerAfter = requireAvatar(
      state.world,
      (a) => a.id === implementer.id,
    );
    const qa = requireAvatar(state.world, (a) => a.agentId === 'qa-1');
    expect(qa.target).toEqual({
      kind: 'avatar',
      avatarId: implementerAfter.id,
    });

    // The task finishes: everyone is sent to the exit.
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap({ finished: true })],
        agents: [
          {
            id: 'planner-1',
            roleId: 'planner-role',
            assignmentId: 'plan-assignment',
            taskId: 'task-1',
            activity: { kind: 'finished' },
          },
          {
            id: 'implementer-1',
            roleId: 'implementer-role',
            assignmentId: 'impl-assignment',
            taskId: 'task-1',
            activity: { kind: 'finished' },
          },
          {
            id: 'qa-1',
            roleId: 'qa-role',
            assignmentId: 'qa-assignment',
            taskId: 'task-1',
            activity: { kind: 'finished' },
          },
        ],
      },
    });
    expect(roomById(state.world, roomId)?.closing).toBe(true);
    for (const id of [planner.id, implementerAfter.id, qa.id]) {
      expect(avatarById(state.world, id)?.target).toEqual({ kind: 'exit' });
    }

    // The room disappears only once everyone has actually left.
    state = officeReducer(state, {
      type: 'avatarExited',
      avatarId: planner.id,
    });
    expect(roomById(state.world, roomId)).toBeDefined();
    state = officeReducer(state, {
      type: 'avatarExited',
      avatarId: implementerAfter.id,
    });
    expect(roomById(state.world, roomId)).toBeDefined();
    state = officeReducer(state, { type: 'avatarExited', avatarId: qa.id });
    expect(roomById(state.world, roomId)).toBeUndefined();
  });
});

describe('a consultation lifecycle', () => {
  it('opens a 1:1 room, seats both sides at its table, and closes it once both have left', () => {
    let state = createInitialOfficeState();
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap()],
        agents: [
          {
            id: 'caller-1',
            roleId: 'caller-role',
            assignmentId: 'caller-assignment',
            taskId: 'task-1',
            activity: { kind: 'working' },
          },
        ],
      },
    });
    const caller = requireAvatar(state.world, (a) => a.agentId === 'caller-1');

    const oneToOneId = 'consultee-assignment-1';
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap()],
        agents: [
          {
            id: 'caller-1',
            roleId: 'caller-role',
            assignmentId: 'caller-assignment',
            taskId: 'task-1',
            activity: { kind: 'consulting', oneToOneId },
          },
          {
            id: 'consultee-1',
            roleId: 'consultee-role',
            assignmentId: oneToOneId,
            taskId: null,
            activity: { kind: 'consulting', oneToOneId },
          },
        ],
      },
    });
    const roomId = oneToOneRoomId(oneToOneId);
    const tableId = `${roomId}:table`;
    expect(roomById(state.world, roomId)).toBeDefined();
    const callerConsulting = requireAvatar(
      state.world,
      (a) => a.id === caller.id,
    );
    const consultee = requireAvatar(
      state.world,
      (a) => a.agentId === 'consultee-1',
    );
    expect(callerConsulting.target).toEqual({
      kind: 'furniture',
      furnitureId: tableId,
    });
    expect(consultee.target).toEqual({
      kind: 'furniture',
      furnitureId: tableId,
    });

    // Both sides walk to the table.
    const table = furnitureById(state.world, tableId);
    if (table === undefined) {
      throw new Error('expected a table');
    }
    state = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: caller.id,
      tile: table.tile,
    });
    state = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: consultee.id,
      tile: table.tile,
    });

    // The consultation ends: the caller resumes work, the consultee finishes.
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [taskSnap()],
        agents: [
          {
            id: 'caller-1',
            roleId: 'caller-role',
            assignmentId: 'caller-assignment',
            taskId: 'task-1',
            activity: { kind: 'working' },
          },
          {
            id: 'consultee-1',
            roleId: 'consultee-role',
            assignmentId: oneToOneId,
            taskId: null,
            activity: { kind: 'finished' },
          },
        ],
      },
    });
    expect(roomById(state.world, roomId)?.closing).toBe(true);
    const callerResumed = requireAvatar(state.world, (a) => a.id === caller.id);
    expect(callerResumed.target).toEqual({
      kind: 'furniture',
      furnitureId: `${taskRoomId('task-1')}:whiteboard`,
    });

    state = officeReducer(state, {
      type: 'avatarExited',
      avatarId: consultee.id,
    });
    expect(roomById(state.world, roomId)).toBeDefined(); // the caller hasn't left yet

    state = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: caller.id,
      tile: { x: 999, y: 999 }, // anywhere well outside the 1:1 room
    });
    expect(roomById(state.world, roomId)).toBeUndefined();
  });
});
