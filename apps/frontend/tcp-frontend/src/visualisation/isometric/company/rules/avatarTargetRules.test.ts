import { describe, expect, it } from 'vitest';

import { createInitialWorld, MAIL_ROOM_ID, taskRoomId } from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import {
  addAgentAvatar,
  addAvatar,
  addRoom,
  claimDesk,
} from '../world/worldOps';
import { applyAvatarTargetRules } from './avatarTargetRules';
import type { CompanySnapshot, SnapshotAgent } from './companySnapshot';

function agent(overrides: Partial<SnapshotAgent> = {}): SnapshotAgent {
  return {
    id: 'agent-1',
    roleId: 'role-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    activity: { kind: 'atDesk' },
    ...overrides,
  };
}

function snapshot(agents: SnapshotAgent[]): CompanySnapshot {
  return { roles: [], tasks: [], agents };
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

/** A task room with one avatar in it, holding a desk but with no target set by any rule yet. */
function worldWithTaskAvatar(overrides: { hasRole?: boolean } = {}): {
  world: OfficeWorld;
  avatarId: string;
} {
  const withRoom = addRoom(
    createInitialWorld(),
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
    location: { x: 3, y: 3 },
    target: { kind: 'tile', tile: { x: 3, y: 3 } },
    placeAtTarget: false,
    hasRole: overrides.hasRole ?? true,
    carrying: null,
    dissociatedSeq: null,
  });
  const claimed = claimDesk(
    created.world,
    taskRoomId('task-1'),
    created.avatarId,
  );
  return { world: claimed.world, avatarId: created.avatarId };
}

/** Adds a role avatar (the rec-room book) for `roleId`, standing wherever. */
function withRoleAvatar(world: OfficeWorld, roleId: string): OfficeWorld {
  return addAvatar(world, {
    id: `role:${roleId}`,
    kind: 'role',
    roleId,
    agentId: null,
    assignmentId: null,
    taskId: null,
    deskId: null,
    location: { x: 0, y: 0 },
    target: { kind: 'tile', tile: { x: 0, y: 0 } },
    placeAtTarget: true,
    hasRole: true,
    carrying: null,
    dissociatedSeq: null,
  });
}

describe('applyAvatarTargetRules', () => {
  it('sends a working avatar to its task room whiteboard', () => {
    const { world, avatarId } = worldWithTaskAvatar();
    const next = applyAvatarTargetRules(
      world,
      snapshot([agent({ activity: { kind: 'working' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: `${taskRoomId('task-1')}:whiteboard`,
    });
  });

  it('sends a reviewing avatar to the avatar it reviews', () => {
    const { world, avatarId } = worldWithTaskAvatar();
    const reviewed = addAgentAvatar(world, {
      roleId: 'role-2',
      agentId: 'agent-2',
      assignmentId: 'reviewed-assignment',
      taskId: 'task-1',
      deskId: null,
      location: { x: 4, y: 4 },
      target: { kind: 'tile', tile: { x: 4, y: 4 } },
      placeAtTarget: false,
      hasRole: true,
      carrying: null,
      dissociatedSeq: null,
    });

    const next = applyAvatarTargetRules(
      reviewed.world,
      snapshot([
        agent({
          activity: {
            kind: 'reviewing',
            reviewedAssignmentId: 'reviewed-assignment',
          },
        }),
      ]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'avatar',
      avatarId: reviewed.avatarId,
    });
  });

  it('falls back to the whiteboard when reviewing has nobody to point at', () => {
    const { world, avatarId } = worldWithTaskAvatar();
    const next = applyAvatarTargetRules(
      world,
      snapshot([
        agent({
          activity: { kind: 'reviewing', reviewedAssignmentId: 'nobody' },
        }),
      ]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: `${taskRoomId('task-1')}:whiteboard`,
    });
  });

  it('sends a messagingUser avatar to the pigeonholes', () => {
    const { world, avatarId } = worldWithTaskAvatar();
    const next = applyAvatarTargetRules(
      world,
      snapshot([agent({ activity: { kind: 'messagingUser' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: `${MAIL_ROOM_ID}:pigeonholes`,
    });
  });

  it('sends an atDesk avatar to its own desk', () => {
    const { world, avatarId } = worldWithTaskAvatar();
    const next = applyAvatarTargetRules(
      world,
      snapshot([agent({ activity: { kind: 'atDesk' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.deskId).not.toBeNull();
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: avatar.deskId,
    });
  });

  it('leaves the target unchanged when no option exists yet', () => {
    const { world, avatarId } = worldWithTaskAvatar();
    const before = requireAvatar(world, (a) => a.id === avatarId);
    const next = applyAvatarTargetRules(
      world,
      snapshot([
        agent({ activity: { kind: 'consulting', oneToOneId: 'no-room-yet' } }),
      ]),
    );
    const after = requireAvatar(next, (a) => a.id === avatarId);
    expect(after.target).toEqual(before.target);
  });

  it('is reference-stable when the target is already right', () => {
    const { world } = worldWithTaskAvatar();
    const snap = snapshot([agent({ activity: { kind: 'atDesk' } })]);
    const once = applyAvatarTargetRules(world, snap);
    const again = applyAvatarTargetRules(once, snap);
    expect(again).toBe(once);
  });

  it("sends an avatar without its role to the role's book, ahead of its activity", () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: false });
    const withRole = withRoleAvatar(world, 'role-1');
    const next = applyAvatarTargetRules(
      withRole,
      snapshot([agent({ activity: { kind: 'atDesk' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({ kind: 'avatar', avatarId: 'role:role-1' });
  });

  it('sends an avatar that already has its role to its activity target, not the role avatar', () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: true });
    const withRole = withRoleAvatar(world, 'role-1');
    const next = applyAvatarTargetRules(
      withRole,
      snapshot([agent({ activity: { kind: 'atDesk' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: avatar.deskId,
    });
  });

  it('falls through to the activity target when the role avatar is missing (the rec room ceiling)', () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: false });
    // No `withRoleAvatar` call: the role's rec-room spot never got one.
    const next = applyAvatarTargetRules(
      world,
      snapshot([agent({ activity: { kind: 'atDesk' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: avatar.deskId,
    });
  });

  it('sends a waiting avatar to its role book, whether or not it already has its role', () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: true });
    const withRole = withRoleAvatar(world, 'role-1');
    const next = applyAvatarTargetRules(
      withRole,
      snapshot([agent({ activity: { kind: 'waiting' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({ kind: 'avatar', avatarId: 'role:role-1' });
  });

  it('a waiting avatar stays at the role book on the next pass — arriving does not re-target it', () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: true });
    const withRole = withRoleAvatar(world, 'role-1');
    const snap = snapshot([agent({ activity: { kind: 'waiting' } })]);
    const once = applyAvatarTargetRules(withRole, snap);
    const again = applyAvatarTargetRules(once, snap);
    expect(again).toBe(once);
    const avatar = requireAvatar(again, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({ kind: 'avatar', avatarId: 'role:role-1' });
  });

  it('a waiting avatar falls back to its own desk when the role avatar is missing (the rec room ceiling)', () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: true });
    // No `withRoleAvatar` call: the role's rec-room spot never got one.
    const next = applyAvatarTargetRules(
      world,
      snapshot([agent({ activity: { kind: 'waiting' } })]),
    );
    const avatar = requireAvatar(next, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: avatar.deskId,
    });
  });

  it('sends a waiting avatar on to the whiteboard once its agent starts running', () => {
    const { world, avatarId } = worldWithTaskAvatar({ hasRole: true });
    const withRole = withRoleAvatar(world, 'role-1');
    const waiting = applyAvatarTargetRules(
      withRole,
      snapshot([agent({ activity: { kind: 'waiting' } })]),
    );
    const running = applyAvatarTargetRules(
      waiting,
      snapshot([agent({ activity: { kind: 'working' } })]),
    );
    const avatar = requireAvatar(running, (a) => a.id === avatarId);
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: `${taskRoomId('task-1')}:whiteboard`,
    });
  });

  it('leaves a role avatar alone — it has no agentId, so the pickup rule never touches it', () => {
    const world = withRoleAvatar(createInitialWorld(), 'role-1');
    const next = applyAvatarTargetRules(world, snapshot([]));
    expect(next).toBe(world);
  });
});
