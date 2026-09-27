import { describe, expect, it } from 'vitest';

import { createInitialWorld, SPAWN_TILE, taskRoomId } from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import {
  addAgentAvatar,
  addRoom,
  claimDesk,
  desksInRoom,
  removeAvatar,
} from '../world/worldOps';
import { applyAgentAvatarRules } from './agentAvatarRules';
import type { RuleContext } from './applyRules';
import type { CompanySnapshot, SnapshotAgent } from './companySnapshot';

const ctxFirst: RuleContext = { firstSnapshot: true };
const ctxLater: RuleContext = { firstSnapshot: false };

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

function worldWithTaskRoom(): OfficeWorld {
  return addRoom(createInitialWorld(), 'task', taskRoomId('task-1'), 'task-1');
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

describe('applyAgentAvatarRules', () => {
  it('spawns a new task agent at the outside tile, claims a desk, and targets it', () => {
    const world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent()]),
      ctxLater,
    );
    const avatar = requireAvatar(world, (a) => a.agentId === 'agent-1');
    expect(avatar.location).toEqual(SPAWN_TILE);
    expect(avatar.deskId).not.toBeNull();
    expect(avatar.target).toEqual({
      kind: 'furniture',
      furnitureId: avatar.deskId,
    });
  });

  it('skips a task agent until its task room exists', () => {
    const world = applyAgentAvatarRules(
      createInitialWorld(),
      snapshot([agent()]),
      ctxLater,
    );
    expect(world.avatars).toHaveLength(0);
  });

  it('reuses a desk freed by an exited avatar rather than adding a new one', () => {
    const withRoom = worldWithTaskRoom();
    const created = addAgentAvatar(withRoom, {
      roleId: 'role-1',
      agentId: 'old-agent',
      assignmentId: 'old-assignment',
      taskId: 'task-1',
      deskId: null,
      location: SPAWN_TILE,
      target: { kind: 'tile', tile: SPAWN_TILE },
      placeAtTarget: false,
      hasRole: true,
    });
    const claimed = claimDesk(
      created.world,
      taskRoomId('task-1'),
      created.avatarId,
    );
    const freed = removeAvatar(claimed.world, created.avatarId);

    const world = applyAgentAvatarRules(
      freed,
      snapshot([agent({ id: 'new-agent' })]),
      ctxLater,
    );

    expect(desksInRoom(world, taskRoomId('task-1'))).toHaveLength(1);
    const avatar = requireAvatar(world, (a) => a.agentId === 'new-agent');
    expect(avatar.deskId).toBe(claimed.deskId);
  });

  it('dissociates a finished agent and sends its avatar back to its desk', () => {
    let world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent()]),
      ctxLater,
    );
    const attached = requireAvatar(world, (a) => a.agentId === 'agent-1');
    const deskId = attached.deskId;

    world = applyAgentAvatarRules(
      world,
      snapshot([agent({ activity: { kind: 'finished' } })]),
      ctxLater,
    );
    const avatar = requireAvatar(world, (a) => a.id === attached.id);
    expect(avatar.agentId).toBeNull();
    expect(avatar.target).toEqual({ kind: 'furniture', furnitureId: deskId });
  });

  it('lets a new agent of the same role take over the waiting avatar', () => {
    let world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent({ id: 'agent-1', roleId: 'role-a' })]),
      ctxLater,
    );
    const before = requireAvatar(world, (a) => a.agentId === 'agent-1');

    world = applyAgentAvatarRules(
      world,
      snapshot([
        agent({
          id: 'agent-1',
          roleId: 'role-a',
          activity: { kind: 'finished' },
        }),
        agent({
          id: 'agent-2',
          roleId: 'role-a',
          assignmentId: 'assignment-2',
        }),
      ]),
      ctxLater,
    );

    const agentAvatars = world.avatars.filter((a) => a.kind === 'agent');
    expect(agentAvatars).toHaveLength(1); // no new avatar, no new desk
    const after = requireAvatar(world, (a) => a.id === before.id);
    expect(after.agentId).toBe('agent-2');
    expect(after.assignmentId).toBe('assignment-2');
    expect(after.deskId).toBe(before.deskId);
  });

  it('gives a different role a new avatar rather than reusing the waiting one', () => {
    let world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent({ id: 'agent-1', roleId: 'role-a' })]),
      ctxLater,
    );

    world = applyAgentAvatarRules(
      world,
      snapshot([
        agent({
          id: 'agent-1',
          roleId: 'role-a',
          activity: { kind: 'finished' },
        }),
        agent({
          id: 'agent-2',
          roleId: 'role-b',
          assignmentId: 'assignment-2',
        }),
      ]),
      ctxLater,
    );

    const agentAvatars = world.avatars.filter((a) => a.kind === 'agent');
    expect(agentAvatars).toHaveLength(2);
    const waiting = requireAvatar(world, (a) => a.roleId === 'role-a');
    expect(waiting.agentId).toBeNull();
    const created = requireAvatar(world, (a) => a.roleId === 'role-b');
    expect(created.agentId).toBe('agent-2');
  });

  it('spawns a consultee or chat agent at the door with no desk, and sends it to the exit when finished', () => {
    const chatAgent = agent({
      id: 'chat-1',
      taskId: null,
      activity: { kind: 'messagingUser' },
    });
    let world = applyAgentAvatarRules(
      createInitialWorld(),
      snapshot([chatAgent]),
      ctxLater,
    );

    const avatar = requireAvatar(world, (a) => a.agentId === 'chat-1');
    expect(avatar.location).toEqual(SPAWN_TILE);
    expect(avatar.deskId).toBeNull();
    expect(avatar.taskId).toBeNull();

    world = applyAgentAvatarRules(
      world,
      snapshot([{ ...chatAgent, activity: { kind: 'finished' } }]),
      ctxLater,
    );
    const dissociated = requireAvatar(world, (a) => a.id === avatar.id);
    expect(dissociated.agentId).toBeNull();
    expect(dissociated.target).toEqual({ kind: 'exit' });
  });

  it('sets placeAtTarget only for an avatar created by the first snapshot', () => {
    const first = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent()]),
      ctxFirst,
    );
    expect(
      requireAvatar(first, (a) => a.agentId === 'agent-1').placeAtTarget,
    ).toBe(true);

    const later = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent({ id: 'agent-2', assignmentId: 'assignment-2' })]),
      ctxLater,
    );
    expect(
      requireAvatar(later, (a) => a.agentId === 'agent-2').placeAtTarget,
    ).toBe(false);
  });

  it('returns the same world when the snapshot repeats with nothing to do', () => {
    const world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent()]),
      ctxLater,
    );
    const again = applyAgentAvatarRules(world, snapshot([agent()]), ctxLater);
    expect(again).toBe(world);
  });
});
