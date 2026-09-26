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
import { removeClosedRooms } from './cleanupRules';
import type {
  AgentActivity,
  CompanySnapshot,
  SnapshotAgent,
  SnapshotTask,
} from './companySnapshot';

function task(overrides: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    id: 't1',
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

describe('removeClosedRooms', () => {
  it('is reference-stable when there is no closing room ready to go', () => {
    const world = createInitialWorld();
    expect(removeClosedRooms(world)).toBe(world);
  });

  it('removes a finished task room with no avatars in the same pass, freeing its slot', () => {
    let state = createInitialOfficeState();
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: { roles: [], tasks: [task()], agents: [] },
    });
    expect(roomById(state.world, taskRoomId('t1'))).toBeDefined();

    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: { roles: [], tasks: [task({ finished: true })], agents: [] },
    });
    expect(roomById(state.world, taskRoomId('t1'))).toBeUndefined(); // gone in the same pass

    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: { roles: [], tasks: [task({ id: 't2' })], agents: [] },
    });
    expect(roomById(state.world, taskRoomId('t2'))?.slot).toBe(2); // the freed slot, reused
  });

  it('removes a finished task room only after its last avatar has exited', () => {
    let state = createInitialOfficeState();
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [task()],
        agents: [
          {
            id: 'agent-1',
            roleId: 'role-1',
            assignmentId: 'assignment-1',
            taskId: 't1',
            activity: { kind: 'atDesk' },
          },
        ],
      },
    });
    const avatar = requireAvatar(state.world, (a) => a.agentId === 'agent-1');

    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: {
        roles: [],
        tasks: [task({ finished: true })],
        agents: [
          {
            id: 'agent-1',
            roleId: 'role-1',
            assignmentId: 'assignment-1',
            taskId: 't1',
            activity: { kind: 'finished' },
          },
        ],
      },
    });
    expect(roomById(state.world, taskRoomId('t1'))?.closing).toBe(true);
    expect(avatarById(state.world, avatar.id)?.target).toEqual({
      kind: 'exit',
    });

    state = officeReducer(state, {
      type: 'avatarExited',
      avatarId: avatar.id,
    });
    expect(avatarById(state.world, avatar.id)).toBeUndefined();
    expect(roomById(state.world, taskRoomId('t1'))).toBeUndefined();
  });

  it('removes a 1:1 room only once the caller has moved elsewhere and the consultee has exited', () => {
    const oneToOneId = 'consultee-assignment-1';
    const callerTaskId = 'task-1';
    const roomId = oneToOneRoomId(oneToOneId);
    const tableId = `${roomId}:table`;

    function callerAgent(activity: AgentActivity): SnapshotAgent {
      return {
        id: 'caller',
        roleId: 'caller-role',
        assignmentId: 'caller-assignment',
        taskId: callerTaskId,
        activity,
      };
    }
    function consulteeAgent(activity: AgentActivity): SnapshotAgent {
      return {
        id: 'consultee',
        roleId: 'consultee-role',
        assignmentId: oneToOneId,
        taskId: null,
        activity,
      };
    }
    function snapshotWith(...agents: SnapshotAgent[]): CompanySnapshot {
      return { roles: [], tasks: [task({ id: callerTaskId })], agents };
    }

    let state = createInitialOfficeState();
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: snapshotWith(
        callerAgent({ kind: 'consulting', oneToOneId }),
        consulteeAgent({ kind: 'consulting', oneToOneId }),
      ),
    });

    const caller = requireAvatar(state.world, (a) => a.agentId === 'caller');
    const consultee = requireAvatar(
      state.world,
      (a) => a.agentId === 'consultee',
    );
    const table = furnitureById(state.world, tableId);
    if (table === undefined) {
      throw new Error('expected a table');
    }

    // Both sides walk to the table before the consultation ends.
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

    // The consultation ends: the caller goes back to work, the consultee finishes.
    state = officeReducer(state, {
      type: 'snapshot',
      snapshot: snapshotWith(
        callerAgent({ kind: 'working' }),
        consulteeAgent({ kind: 'finished' }),
      ),
    });
    expect(roomById(state.world, roomId)?.closing).toBe(true);

    // Only the consultee has exited: the caller is still standing in the room.
    state = officeReducer(state, {
      type: 'avatarExited',
      avatarId: consultee.id,
    });
    expect(roomById(state.world, roomId)).toBeDefined();

    // The caller arrives at its own whiteboard, outside the 1:1 room.
    const whiteboard = furnitureById(
      state.world,
      `${taskRoomId(callerTaskId)}:whiteboard`,
    );
    if (whiteboard === undefined) {
      throw new Error('expected a whiteboard');
    }
    state = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: caller.id,
      tile: whiteboard.tile,
    });
    expect(roomById(state.world, roomId)).toBeUndefined();
  });
});
