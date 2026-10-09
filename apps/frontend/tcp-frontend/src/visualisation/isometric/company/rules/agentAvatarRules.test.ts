import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_BOOKSHELF_ID,
  createInitialWorld,
  SPAWN_TILE,
  taskRoomId,
} from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import {
  addAgentAvatar,
  addRoom,
  claimDesk,
  desksInRoom,
  removeAvatar,
  setRoomClosing,
} from '../world/worldOps';
import { applyAgentAvatarRules } from './agentAvatarRules';
import type { RuleContext } from './applyRules';
import type {
  CompanySnapshot,
  SnapshotAgent,
  SnapshotTask,
} from './companySnapshot';

const ctxFirst: RuleContext = { firstSnapshot: true };
const ctxLater: RuleContext = { firstSnapshot: false };

function agent(overrides: Partial<SnapshotAgent> = {}): SnapshotAgent {
  return {
    id: 'agent-1',
    roleId: 'role-1',
    assignmentId: 'assignment-1',
    taskId: 'task-1',
    status: 'idle',
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

  it('gives no avatar to a live agent on a finished task, whose room is still open', () => {
    const finishedTask: SnapshotTask = {
      id: 'task-1',
      shortcode: 'T1',
      request: 'Do the thing',
      finished: true,
      succeeded: true,
      status: 'succeeded',
      pausedAt: null,
      visualisationClosedAt: null,
      step: 1,
      steps: 1,
    };
    const world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      { roles: [], tasks: [finishedTask], agents: [agent()] },
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
      carrying: null,
      dissociatedSeq: null,
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
          status: 'completed',
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
          status: 'completed',
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
      status: 'idle',
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

  it('gives a first-snapshot avatar hasRole true, straight away', () => {
    const world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent()]),
      ctxFirst,
    );
    expect(requireAvatar(world, (a) => a.agentId === 'agent-1').hasRole).toBe(
      true,
    );
  });

  it('gives a later-snapshot avatar hasRole false, so it collects its role first', () => {
    const world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent()]),
      ctxLater,
    );
    expect(requireAvatar(world, (a) => a.agentId === 'agent-1').hasRole).toBe(
      false,
    );
  });

  it("keeps a reused waiting avatar's hasRole, rather than resetting it", () => {
    // The waiting avatar was created on the first snapshot, so it already
    // carries its role; a role-mate taking it over shouldn't lose that.
    let world = applyAgentAvatarRules(
      worldWithTaskRoom(),
      snapshot([agent({ id: 'agent-1', roleId: 'role-a' })]),
      ctxFirst,
    );
    const before = requireAvatar(world, (a) => a.agentId === 'agent-1');
    expect(before.hasRole).toBe(true);

    world = applyAgentAvatarRules(
      world,
      snapshot([
        agent({
          id: 'agent-1',
          roleId: 'role-a',
          status: 'completed',
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

    const after = requireAvatar(world, (a) => a.id === before.id);
    expect(after.agentId).toBe('agent-2');
    expect(after.hasRole).toBe(true);
  });

  it('never reuses the carrier of a closing room for a new agent of the same role', () => {
    // A carrier looks like a waiting avatar (agentId null, target not
    // 'exit'), so it's the room's `closing` flag — not the target — that
    // must stop `attachTaskAgent` from handing it a new agent.
    const withRoom = worldWithTaskRoom();
    const created = addAgentAvatar(withRoom, {
      roleId: 'role-1',
      agentId: null,
      assignmentId: 'old-assignment',
      taskId: 'task-1',
      deskId: null,
      location: SPAWN_TILE,
      target: { kind: 'furniture', furnitureId: ARCHIVE_BOOKSHELF_ID },
      placeAtTarget: false,
      hasRole: true,
      carrying: 'outputs',
      dissociatedSeq: 3,
    });
    const closing = setRoomClosing(created.world, taskRoomId('task-1'));

    const world = applyAgentAvatarRules(
      closing,
      snapshot([agent({ id: 'new-agent', roleId: 'role-1' })]),
      ctxLater,
    );

    const carrier = requireAvatar(world, (a) => a.id === created.avatarId);
    expect(carrier.agentId).toBeNull();
    expect(carrier.carrying).toBe('outputs');
    expect(carrier.target).toEqual({
      kind: 'furniture',
      furnitureId: ARCHIVE_BOOKSHELF_ID,
    });
    expect(world.avatars.some((a) => a.agentId === 'new-agent')).toBe(false);
  });
});
