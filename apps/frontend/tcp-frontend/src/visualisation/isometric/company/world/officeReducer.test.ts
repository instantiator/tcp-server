import { describe, expect, it } from 'vitest';

import type { CompanySnapshot } from '../rules/companySnapshot';
import { createInitialOfficeState, officeReducer } from './officeReducer';
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
});
