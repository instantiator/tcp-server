import { describe, expect, it } from 'vitest';

import type { CompanySnapshot } from '../rules/companySnapshot';
import { createInitialOfficeState, officeReducer } from './officeReducer';
import { taskRoomId } from './layout';
import { addAgentAvatar, addRoom, avatarById, claimDesk } from './worldOps';

function snapshot(roleIds: string[] = ['a']): CompanySnapshot {
  return {
    roles: roleIds.map((id) => ({ id, name: `Role ${id}` })),
    tasks: [],
    agents: [],
  };
}

describe('createInitialOfficeState', () => {
  it('starts with the initial world and no snapshot', () => {
    const state = createInitialOfficeState();
    expect(state.snapshot).toBeNull();
    expect(state.world.avatars).toEqual([]);
  });
});

describe('officeReducer', () => {
  it('adds role avatars on the first snapshot', () => {
    const state = createInitialOfficeState();
    const next = officeReducer(state, {
      type: 'snapshot',
      snapshot: snapshot(),
    });
    expect(avatarById(next.world, 'role:a')).toBeDefined();
    expect(next.snapshot).not.toBeNull();
  });

  it("sets an avatar's location on avatarArrived", () => {
    let state = createInitialOfficeState();
    state = officeReducer(state, { type: 'snapshot', snapshot: snapshot() });

    const next = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: 'role:a',
      tile: { x: 1, y: 1 },
    });
    expect(avatarById(next.world, 'role:a')?.location).toEqual({ x: 1, y: 1 });
  });

  it('removes the avatar and frees its desk on avatarExited', () => {
    const world = addRoom(createInitialOfficeState().world, 'task', 'task:t1');
    const { world: withAvatar, avatarId } = addAgentAvatar(world, {
      roleId: 'role-1',
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      deskId: null,
      location: { x: 0, y: 7 },
      target: { kind: 'exit' },
      placeAtTarget: false,
      hasRole: true,
      carrying: null,
      dissociatedSeq: null,
    });
    const claim = claimDesk(withAvatar, 'task:t1', avatarId);
    const state = { world: claim.world, snapshot: null };

    const next = officeReducer(state, { type: 'avatarExited', avatarId });
    expect(avatarById(next.world, avatarId)).toBeUndefined();
    expect(
      next.world.furniture.find((item) => item.id === claim.deskId)
        ?.ownerAvatarId,
    ).toBeUndefined();
  });

  it('is reference-equal when nothing changes', () => {
    let state = createInitialOfficeState();
    state = officeReducer(state, { type: 'snapshot', snapshot: snapshot() });

    const same = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: 'unknown-avatar',
      tile: { x: 0, y: 0 },
    });
    expect(same).toBe(state);
  });

  it("sets hasRole and re-targets the avatar when it arrives at its role's pickup stop", () => {
    const withRoom = addRoom(
      createInitialOfficeState().world,
      'task',
      taskRoomId('task-1'),
      'task-1',
    );
    const created = addAgentAvatar(withRoom, {
      roleId: 'role-1',
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      deskId: null,
      location: { x: 0, y: 7 },
      target: { kind: 'avatar', avatarId: 'role:role-1' },
      placeAtTarget: false,
      hasRole: false,
      carrying: null,
      dissociatedSeq: null,
    });
    const claimed = claimDesk(
      created.world,
      taskRoomId('task-1'),
      created.avatarId,
    );
    const snap: CompanySnapshot = {
      roles: [{ id: 'role-1', name: 'Role 1' }],
      tasks: [
        {
          id: 'task-1',
          shortcode: 'T1',
          request: 'Do the thing',
          finished: false,
          succeeded: false,
          status: 'in-progress',
          pausedAt: null,
          visualisationClosedAt: null,
          step: 0,
          steps: 0,
        },
      ],
      agents: [
        {
          id: 'agent-1',
          roleId: 'role-1',
          assignmentId: 'assignment-1',
          taskId: 'task-1',
          status: 'idle',
          activity: { kind: 'atDesk' },
        },
      ],
    };
    const state = { world: claimed.world, snapshot: snap };

    const next = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: created.avatarId,
      tile: { x: 5, y: 5 }, // wherever the role's rec-room spot is
    });

    const avatar = avatarById(next.world, created.avatarId);
    expect(avatar?.hasRole).toBe(true);
    // The rules re-run straight after, and — with its role collected —
    // send it on to its desk rather than leaving it parked on the role.
    expect(avatar?.target).toEqual({
      kind: 'furniture',
      furnitureId: claimed.deskId,
    });
  });

  it("doesn't set hasRole when the avatar arrives somewhere other than its role", () => {
    const withRoom = addRoom(
      createInitialOfficeState().world,
      'task',
      taskRoomId('task-1'),
      'task-1',
    );
    const created = addAgentAvatar(withRoom, {
      roleId: 'role-1',
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      taskId: 'task-1',
      deskId: null,
      location: { x: 0, y: 7 },
      target: { kind: 'tile', tile: { x: 3, y: 3 } },
      placeAtTarget: false,
      hasRole: false,
      carrying: null,
      dissociatedSeq: null,
    });
    const state = { world: created.world, snapshot: null };

    const next = officeReducer(state, {
      type: 'avatarArrived',
      avatarId: created.avatarId,
      tile: { x: 3, y: 3 },
    });

    expect(avatarById(next.world, created.avatarId)?.hasRole).toBe(false);
  });
});
