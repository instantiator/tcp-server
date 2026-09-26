import { describe, expect, it } from 'vitest';

import {
  CORRIDOR_ID,
  corridorBounds,
  createInitialWorld,
  doorTile,
  firstFreeSlot,
  mapBounds,
  MAIL_ROOM_ID,
  OFFICE_DOOR_TILE,
  REC_ROOM_ID,
  slotBounds,
} from './layout';
import type { Room } from './types';

describe('slotBounds', () => {
  it('places slot 0 in column 0, north of the corridor', () => {
    expect(slotBounds(0)).toEqual({ x: 2, y: 0, width: 9, height: 7 });
  });

  it('places slot 1 in column 0, south of the corridor', () => {
    expect(slotBounds(1)).toEqual({ x: 2, y: 9, width: 9, height: 7 });
  });

  it('places slot 2 in column 1, north of the corridor', () => {
    expect(slotBounds(2)).toEqual({ x: 11, y: 0, width: 9, height: 7 });
  });

  it('places slot 3 in column 1, south of the corridor', () => {
    expect(slotBounds(3)).toEqual({ x: 11, y: 9, width: 9, height: 7 });
  });
});

describe('doorTile', () => {
  it('sits on the corridor-facing (bottom) wall of a north slot', () => {
    expect(doorTile(0)).toEqual({ x: 6, y: 6 });
    expect(doorTile(2)).toEqual({ x: 15, y: 6 });
  });

  it('sits on the corridor-facing (top) wall of a south slot', () => {
    expect(doorTile(1)).toEqual({ x: 6, y: 9 });
    expect(doorTile(3)).toEqual({ x: 15, y: 9 });
  });

  it('is offset from the slot by DOOR_OFFSET_X either way', () => {
    const north = slotBounds(0);
    const south = slotBounds(1);
    expect(doorTile(0).x - north.x).toBe(4);
    expect(doorTile(1).x - south.x).toBe(4);
  });
});

describe('firstFreeSlot', () => {
  it('is 2 for the initial world, since 0 and 1 are the fixed rooms', () => {
    expect(firstFreeSlot(createInitialWorld().rooms)).toBe(2);
  });

  it('reuses a freed slot instead of continuing past it', () => {
    const withTwoAndThree = [
      ...createInitialWorld().rooms,
      roomAt(2, 'task:a'),
      roomAt(3, 'task:b'),
    ];
    expect(firstFreeSlot(withTwoAndThree)).toBe(4);

    const freedTwo = withTwoAndThree.filter((room) => room.slot !== 2);
    expect(firstFreeSlot(freedTwo)).toBe(2);
  });
});

function roomAt(slot: number, id: string): Room {
  return {
    id,
    purpose: 'task',
    slot,
    bounds: slotBounds(slot),
    door: doorTile(slot),
    closing: false,
  };
}

describe('corridorBounds', () => {
  it('spans one column', () => {
    expect(corridorBounds(1)).toEqual({ x: 1, y: 7, width: 10, height: 2 });
  });

  it('spans three columns', () => {
    expect(corridorBounds(3)).toEqual({ x: 1, y: 7, width: 28, height: 2 });
  });
});

describe('mapBounds', () => {
  it('covers the whole map for one corridor column', () => {
    const world = createInitialWorld();
    expect(mapBounds(world)).toEqual({ x: 0, y: 0, width: 12, height: 16 });
  });

  it('grows with the corridor for three columns', () => {
    const world = { ...createInitialWorld(), corridorColumns: 3 };
    expect(mapBounds(world)).toEqual({ x: 0, y: 0, width: 30, height: 16 });
  });
});

describe('createInitialWorld', () => {
  const world = createInitialWorld();

  it('has exactly three rooms: rec, mail and the corridor', () => {
    expect(world.rooms.map((room) => room.id).sort()).toEqual(
      [REC_ROOM_ID, MAIL_ROOM_ID, CORRIDOR_ID].sort(),
    );
  });

  it('gives the rec and mail rooms their fixed slots', () => {
    const rec = world.rooms.find((room) => room.id === REC_ROOM_ID);
    const mail = world.rooms.find((room) => room.id === MAIL_ROOM_ID);
    expect(rec?.slot).toBe(0);
    expect(mail?.slot).toBe(1);
  });

  it('includes the office door, walkable furniture at the fixed tile', () => {
    const officeDoor = world.furniture.find(
      (item) => item.kind === 'officeDoor',
    );
    expect(officeDoor).toEqual({
      id: 'corridor:officeDoor',
      kind: 'officeDoor',
      roomId: CORRIDOR_ID,
      tile: OFFICE_DOOR_TILE,
    });
  });

  it('furnishes the rec room with two sofas', () => {
    const sofas = world.furniture.filter(
      (item) => item.roomId === REC_ROOM_ID && item.kind === 'sofa',
    );
    expect(sofas).toHaveLength(2);
  });

  it('furnishes the mail room with pigeonholes', () => {
    const pigeonholes = world.furniture.filter(
      (item) => item.roomId === MAIL_ROOM_ID && item.kind === 'pigeonholes',
    );
    expect(pigeonholes).toHaveLength(1);
  });

  it('starts with no avatars, layout version 0, one avatar-number slot free', () => {
    expect(world.avatars).toEqual([]);
    expect(world.layoutVersion).toBe(0);
    expect(world.nextAvatarNumber).toBe(1);
    expect(world.corridorColumns).toBe(1);
  });
});
