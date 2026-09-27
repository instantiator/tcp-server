import { describe, expect, it } from 'vitest';

import { MAX_DESKS_PER_ROOM } from './furnishing';
import {
  CORRIDOR_ID,
  createInitialWorld,
  MAIL_ROOM_ID,
  REC_ROOM_ID,
} from './layout';
import type { Avatar, AvatarTarget } from './types';
import {
  addAgentAvatar,
  addAvatar,
  addRoom,
  avatarById,
  claimDesk,
  desksInRoom,
  furnitureById,
  releaseDesk,
  removeAvatar,
  removeRoom,
  roomById,
  sameTarget,
  sameTile,
  setRoomClosing,
  updateAvatar,
} from './worldOps';

function makeAvatar(overrides: Partial<Avatar> = {}): Avatar {
  return {
    id: 'agent-avatar:1',
    kind: 'agent',
    roleId: 'role-1',
    agentId: 'agent-1',
    assignmentId: 'assignment-1',
    taskId: null,
    deskId: null,
    location: { x: 0, y: 7 },
    target: { kind: 'exit' },
    placeAtTarget: false,
    hasRole: true,
    ...overrides,
  };
}

describe('roomById', () => {
  it('finds a room by id', () => {
    const world = createInitialWorld();
    expect(roomById(world, REC_ROOM_ID)?.id).toBe(REC_ROOM_ID);
  });

  it('is undefined for an unknown id', () => {
    const world = createInitialWorld();
    expect(roomById(world, 'nope')).toBeUndefined();
  });
});

describe('furnitureById', () => {
  it('finds furniture by id', () => {
    const world = createInitialWorld();
    expect(furnitureById(world, 'mail:pigeonholes')?.kind).toBe('pigeonholes');
  });

  it('is undefined for an unknown id', () => {
    const world = createInitialWorld();
    expect(furnitureById(world, 'nope')).toBeUndefined();
  });
});

describe('avatarById', () => {
  it('finds an avatar by id', () => {
    const world = addAvatar(createInitialWorld(), makeAvatar());
    expect(avatarById(world, 'agent-avatar:1')?.roleId).toBe('role-1');
  });

  it('is undefined for an unknown id', () => {
    const world = createInitialWorld();
    expect(avatarById(world, 'nope')).toBeUndefined();
  });
});

describe('desksInRoom', () => {
  it('is empty for a room with no desks', () => {
    const world = createInitialWorld();
    expect(desksInRoom(world, REC_ROOM_ID)).toEqual([]);
  });

  it('sorts desks by the number in their id, not insertion order', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    world = claimDesk(world, 'task:t1', 'a1').world; // desk:1
    world = claimDesk(world, 'task:t1', 'a2').world; // desk:2
    world = claimDesk(world, 'task:t1', 'a3').world; // desk:3

    const desks = desksInRoom(world, 'task:t1');
    expect(desks.map((desk) => desk.id)).toEqual([
      'task:t1:desk:1',
      'task:t1:desk:2',
      'task:t1:desk:3',
    ]);
  });
});

describe('addRoom', () => {
  it('adds a task room in the first free slot, furnished with a whiteboard', () => {
    const world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const room = roomById(world, 'task:t1');
    expect(room?.slot).toBe(2);
    expect(room?.closing).toBe(false);
    expect(
      world.furniture.some(
        (item) => item.roomId === 'task:t1' && item.kind === 'whiteboard',
      ),
    ).toBe(true);
  });

  it('carries the taskId only when one is given', () => {
    const withTaskId = addRoom(
      createInitialWorld(),
      'task',
      'task:t1',
      'task-1',
    );
    expect(roomById(withTaskId, 'task:t1')?.taskId).toBe('task-1');

    const oneToOne = addRoom(createInitialWorld(), 'oneToOne', 'oneToOne:a1');
    expect(roomById(oneToOne, 'oneToOne:a1')?.taskId).toBeUndefined();
  });

  it('is unchanged when the id already names a room', () => {
    const withRoom = addRoom(createInitialWorld(), 'task', 'task:t1');
    expect(addRoom(withRoom, 'task', 'task:t1')).toBe(withRoom);
  });

  it('grows corridorColumns, and the corridor bounds, into a new column', () => {
    let world = createInitialWorld();
    expect(world.corridorColumns).toBe(1);

    world = addRoom(world, 'task', 'task:t1'); // slot 2, column 1
    expect(world.corridorColumns).toBe(2);
    expect(roomById(world, CORRIDOR_ID)?.bounds).toEqual({
      x: 1,
      y: 7,
      width: 19,
      height: 2,
    });
  });

  it('bumps layoutVersion', () => {
    const world = createInitialWorld();
    const withRoom = addRoom(world, 'task', 'task:t1');
    expect(withRoom.layoutVersion).toBe(world.layoutVersion + 1);
  });
});

describe('removeRoom', () => {
  it('removes the room and its furniture, freeing any desk it held', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const claim = claimDesk(world, 'task:t1', 'agent-avatar:1');
    world = addAvatar(claim.world, makeAvatar({ deskId: claim.deskId }));

    const removed = removeRoom(world, 'task:t1');
    expect(roomById(removed, 'task:t1')).toBeUndefined();
    expect(removed.furniture.some((item) => item.roomId === 'task:t1')).toBe(
      false,
    );
    expect(avatarById(removed, 'agent-avatar:1')?.deskId).toBeNull();
  });

  it('is unchanged for an unknown room', () => {
    const world = createInitialWorld();
    expect(removeRoom(world, 'nope')).toBe(world);
  });

  it('is unchanged for the fixed rooms', () => {
    const world = createInitialWorld();
    expect(removeRoom(world, REC_ROOM_ID)).toBe(world);
    expect(removeRoom(world, MAIL_ROOM_ID)).toBe(world);
    expect(removeRoom(world, CORRIDOR_ID)).toBe(world);
  });

  it('never shrinks corridorColumns', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    expect(world.corridorColumns).toBe(2);
    world = removeRoom(world, 'task:t1');
    expect(world.corridorColumns).toBe(2);
  });

  it('bumps layoutVersion', () => {
    const world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const removed = removeRoom(world, 'task:t1');
    expect(removed.layoutVersion).toBe(world.layoutVersion + 1);
  });
});

describe('setRoomClosing', () => {
  it('marks a room as closing', () => {
    const world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const closing = setRoomClosing(world, 'task:t1');
    expect(roomById(closing, 'task:t1')?.closing).toBe(true);
  });

  it('is unchanged for an unknown room', () => {
    const world = createInitialWorld();
    expect(setRoomClosing(world, 'nope')).toBe(world);
  });

  it('is unchanged when already closing', () => {
    const world = setRoomClosing(
      addRoom(createInitialWorld(), 'task', 'task:t1'),
      'task:t1',
    );
    expect(setRoomClosing(world, 'task:t1')).toBe(world);
  });
});

describe('claimDesk', () => {
  it('adds the first desk when the room has none', () => {
    const world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const { world: next, deskId } = claimDesk(
      world,
      'task:t1',
      'agent-avatar:1',
    );
    expect(deskId).toBe('task:t1:desk:1');
    expect(furnitureById(next, 'task:t1:desk:1')?.ownerAvatarId).toBe(
      'agent-avatar:1',
    );
  });

  it("sets the claiming avatar's deskId when the avatar exists", () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    world = addAvatar(world, makeAvatar());
    const { world: next, deskId } = claimDesk(
      world,
      'task:t1',
      'agent-avatar:1',
    );
    expect(avatarById(next, 'agent-avatar:1')?.deskId).toBe(deskId);
  });

  it('reuses a released desk before adding a new one', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const first = claimDesk(world, 'task:t1', 'a1');
    world = first.world;
    expect(first.deskId).toBe('task:t1:desk:1');

    world = releaseDesk(world, 'task:t1:desk:1');
    const second = claimDesk(world, 'task:t1', 'a2');
    expect(second.deskId).toBe('task:t1:desk:1');
    expect(desksInRoom(second.world, 'task:t1')).toHaveLength(1);
  });

  it('returns deskId null once the room holds MAX_DESKS_PER_ROOM desks', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    for (let i = 0; i < MAX_DESKS_PER_ROOM; i += 1) {
      world = claimDesk(world, 'task:t1', `a${String(i)}`).world;
    }
    expect(desksInRoom(world, 'task:t1')).toHaveLength(MAX_DESKS_PER_ROOM);

    const result = claimDesk(world, 'task:t1', 'overflow');
    expect(result.deskId).toBeNull();
    expect(result.world).toBe(world);
  });

  it('is unchanged, with a null deskId, for an unknown room', () => {
    const world = createInitialWorld();
    expect(claimDesk(world, 'nope', 'a1')).toEqual({ world, deskId: null });
  });

  it('bumps layoutVersion only when it adds a desk, not when it reuses one', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const beforeFirstClaim = world.layoutVersion;
    const first = claimDesk(world, 'task:t1', 'a1');
    expect(first.world.layoutVersion).toBe(beforeFirstClaim + 1);

    world = releaseDesk(first.world, 'task:t1:desk:1');
    const reused = claimDesk(world, 'task:t1', 'a2');
    expect(reused.world.layoutVersion).toBe(world.layoutVersion);
  });
});

describe('releaseDesk', () => {
  it("clears the owner and the holding avatar's deskId", () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const claim = claimDesk(world, 'task:t1', 'agent-avatar:1');
    world = addAvatar(claim.world, makeAvatar({ deskId: claim.deskId }));

    const released = releaseDesk(world, 'task:t1:desk:1');
    expect(
      furnitureById(released, 'task:t1:desk:1')?.ownerAvatarId,
    ).toBeUndefined();
    expect(avatarById(released, 'agent-avatar:1')?.deskId).toBeNull();
  });

  it('is unchanged for an unknown desk', () => {
    const world = createInitialWorld();
    expect(releaseDesk(world, 'nope')).toBe(world);
  });
});

describe('addAvatar', () => {
  it('appends a new avatar', () => {
    const world = addAvatar(createInitialWorld(), makeAvatar());
    expect(avatarById(world, 'agent-avatar:1')).toBeDefined();
  });

  it('is unchanged when the id already exists', () => {
    const world = addAvatar(createInitialWorld(), makeAvatar());
    expect(addAvatar(world, makeAvatar())).toBe(world);
  });
});

describe('addAgentAvatar', () => {
  it('assigns the next agent-avatar id and kind, and bumps nextAvatarNumber', () => {
    const world = createInitialWorld();
    const { world: next, avatarId } = addAgentAvatar(world, {
      roleId: 'role-1',
      agentId: 'agent-1',
      assignmentId: 'assignment-1',
      taskId: null,
      deskId: null,
      location: { x: 0, y: 7 },
      target: { kind: 'exit' },
      placeAtTarget: false,
      hasRole: true,
    });
    expect(avatarId).toBe('agent-avatar:1');
    expect(avatarById(next, avatarId)?.kind).toBe('agent');
    expect(next.nextAvatarNumber).toBe(world.nextAvatarNumber + 1);
  });
});

describe('sameTile', () => {
  it('is true for equal coordinates', () => {
    expect(sameTile({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
  });

  it('is false when either coordinate differs', () => {
    expect(sameTile({ x: 1, y: 2 }, { x: 1, y: 3 })).toBe(false);
    expect(sameTile({ x: 1, y: 2 }, { x: 2, y: 2 })).toBe(false);
  });
});

describe('sameTarget', () => {
  it('is false when the kinds differ', () => {
    const a: AvatarTarget = { kind: 'exit' };
    const b: AvatarTarget = { kind: 'tile', tile: { x: 0, y: 0 } };
    expect(sameTarget(a, b)).toBe(false);
  });

  it('compares furniture targets by furnitureId', () => {
    const a: AvatarTarget = { kind: 'furniture', furnitureId: 'x' };
    const b: AvatarTarget = { kind: 'furniture', furnitureId: 'x' };
    const c: AvatarTarget = { kind: 'furniture', furnitureId: 'y' };
    expect(sameTarget(a, b)).toBe(true);
    expect(sameTarget(a, c)).toBe(false);
  });

  it('compares avatar targets by avatarId', () => {
    const a: AvatarTarget = { kind: 'avatar', avatarId: 'x' };
    const b: AvatarTarget = { kind: 'avatar', avatarId: 'x' };
    const c: AvatarTarget = { kind: 'avatar', avatarId: 'y' };
    expect(sameTarget(a, b)).toBe(true);
    expect(sameTarget(a, c)).toBe(false);
  });

  it('compares tile targets by value', () => {
    const a: AvatarTarget = { kind: 'tile', tile: { x: 1, y: 1 } };
    const b: AvatarTarget = { kind: 'tile', tile: { x: 1, y: 1 } };
    const c: AvatarTarget = { kind: 'tile', tile: { x: 2, y: 1 } };
    expect(sameTarget(a, b)).toBe(true);
    expect(sameTarget(a, c)).toBe(false);
  });

  it('treats every exit target as the same', () => {
    expect(sameTarget({ kind: 'exit' }, { kind: 'exit' })).toBe(true);
  });
});

describe('updateAvatar', () => {
  it('patches a field', () => {
    const world = addAvatar(createInitialWorld(), makeAvatar());
    const next = updateAvatar(world, 'agent-avatar:1', { deskId: 'd1' });
    expect(avatarById(next, 'agent-avatar:1')?.deskId).toBe('d1');
  });

  it('compares location and target by value, not by reference', () => {
    const world = addAvatar(
      createInitialWorld(),
      makeAvatar({ location: { x: 3, y: 3 }, target: { kind: 'exit' } }),
    );
    const next = updateAvatar(world, 'agent-avatar:1', {
      location: { x: 3, y: 3 }, // a fresh object, same value
      target: { kind: 'exit' },
    });
    expect(next).toBe(world);
  });

  it('is unchanged when every patched field already matches', () => {
    const world = addAvatar(createInitialWorld(), makeAvatar({ deskId: 'd1' }));
    expect(updateAvatar(world, 'agent-avatar:1', { deskId: 'd1' })).toBe(world);
  });

  it('is unchanged for an unknown avatar', () => {
    const world = createInitialWorld();
    expect(updateAvatar(world, 'nope', { deskId: 'd1' })).toBe(world);
  });
});

describe('removeAvatar', () => {
  it('removes the avatar and frees its desk', () => {
    let world = addRoom(createInitialWorld(), 'task', 'task:t1');
    const claim = claimDesk(world, 'task:t1', 'agent-avatar:1');
    world = addAvatar(claim.world, makeAvatar({ deskId: claim.deskId }));

    const next = removeAvatar(world, 'agent-avatar:1');
    expect(avatarById(next, 'agent-avatar:1')).toBeUndefined();
    expect(
      furnitureById(next, 'task:t1:desk:1')?.ownerAvatarId,
    ).toBeUndefined();
  });

  it('is unchanged for an unknown avatar', () => {
    const world = createInitialWorld();
    expect(removeAvatar(world, 'nope')).toBe(world);
  });
});
