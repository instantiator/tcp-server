import { describe, expect, it } from 'vitest';

import { createInitialWorld, MAIL_ROOM_ID, taskRoomId } from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import { addAgentAvatar, addRoom, claimDesk } from '../world/worldOps';
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
function worldWithTaskAvatar(): { world: OfficeWorld; avatarId: string } {
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
    hasRole: true,
  });
  const claimed = claimDesk(
    created.world,
    taskRoomId('task-1'),
    created.avatarId,
  );
  return { world: claimed.world, avatarId: created.avatarId };
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
});
