import { furnishRoom } from './furnishing';
import type { Bounds, Furniture, OfficeWorld, Room, Tile } from './types';

/*
 * The office plan. One corridor runs east from the office door. Rooms sit in
 * fixed-size slots on both sides of it: even slots to the north, odd slots to
 * the south, two slots to a column.
 *
 *   y 0..6    north rooms (slot 0, 2, 4 …)      door gap in the south wall
 *   y 7..8    corridor                           outside tiles at x 0
 *   y 9..15   south rooms (slot 1, 3, 5 …)      door gap in the north wall
 *
 * Fixed slots never move, so removing one room never shifts another under an
 * avatar. Every room is a dead end off the corridor, so no route ever passes
 * through a room that is not its destination.
 */

/** A room's width in tiles, walls included. */
export const ROOM_WIDTH = 9;
/** A room's height in tiles, walls included. */
export const ROOM_HEIGHT = 7;
/** The corridor's first floor row. Its second is `CORRIDOR_Y + 1`. */
export const CORRIDOR_Y = ROOM_HEIGHT;
/** The top row of every south room. */
export const SOUTH_ROOM_Y = ROOM_HEIGHT + 2;
/** The height of the whole map: north rooms, corridor, south rooms. */
export const MAP_HEIGHT = 2 * ROOM_HEIGHT + 2;
/** The `x` of column 0's left wall. `x = 0` is outside and `x = 1` holds the office door. */
export const FIRST_SLOT_X = 2;
/** How far along a room's corridor-facing wall its door gap is. */
export const DOOR_OFFSET_X = 4;
/** The column of tiles outside the office door, on both corridor rows. */
export const OUTSIDE_X = 0;
/** Just outside the office door: where a new agent avatar appears. */
export const SPAWN_TILE: Tile = { x: OUTSIDE_X, y: CORRIDOR_Y };
/** The office door. The tile beside it, `(1, CORRIDOR_Y + 1)`, is wall. */
export const OFFICE_DOOR_TILE: Tile = { x: 1, y: CORRIDOR_Y };

export const REC_ROOM_SLOT = 0;
export const MAIL_ROOM_SLOT = 1;
/** Task and 1:1 rooms take the first free slot from here. */
export const FIRST_DYNAMIC_SLOT = 2;

export const REC_ROOM_ID = 'rec';
export const MAIL_ROOM_ID = 'mail';
export const CORRIDOR_ID = 'corridor';

/** The id of the room for a task. */
export const taskRoomId = (taskId: string): string => `task:${taskId}`;

/** The id of the 1:1 room for a consultation, keyed by the consultee's assignment. */
export const oneToOneRoomId = (consulteeAssignmentId: string): string =>
  `oneToOne:${consulteeAssignmentId}`;

/** The slot column a slot is in. */
export const columnOfSlot = (slot: number): number => Math.floor(slot / 2);

/** Even slots are north of the corridor, odd slots south. */
export const isNorthSlot = (slot: number): boolean => slot % 2 === 0;

/**
 * A slot's area, walls included: `ROOM_WIDTH` × `ROOM_HEIGHT`, starting at
 * `x = FIRST_SLOT_X + column * ROOM_WIDTH`, and at `y = 0` (north) or
 * `y = SOUTH_ROOM_Y` (south).
 */
export function slotBounds(slot: number): Bounds {
  return {
    x: FIRST_SLOT_X + columnOfSlot(slot) * ROOM_WIDTH,
    y: isNorthSlot(slot) ? 0 : SOUTH_ROOM_Y,
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
  };
}

/**
 * The gap in a slot's corridor-facing wall: `x = left + DOOR_OFFSET_X`, on the
 * bottom row of a north room or the top row of a south room.
 */
export function doorTile(slot: number): Tile {
  const bounds = slotBounds(slot);
  return {
    x: bounds.x + DOOR_OFFSET_X,
    y: isNorthSlot(slot) ? ROOM_HEIGHT - 1 : SOUTH_ROOM_Y,
  };
}

/** The lowest slot from `FIRST_DYNAMIC_SLOT` up that no room holds. A freed slot is reused. */
export function firstFreeSlot(rooms: readonly Room[]): number {
  const taken = new Set(
    rooms
      .map((room) => room.slot)
      .filter((slot): slot is number => slot !== null),
  );
  let slot = FIRST_DYNAMIC_SLOT;
  while (taken.has(slot)) {
    slot += 1;
  }
  return slot;
}

/**
 * The corridor's floor: the two rows from `CORRIDOR_Y`, from `x = 1` (the
 * office door) to the right-hand wall of the last column,
 * `FIRST_SLOT_X + columns * ROOM_WIDTH - 1`.
 */
export function corridorBounds(columns: number): Bounds {
  return {
    x: 1,
    y: CORRIDOR_Y,
    width: FIRST_SLOT_X + columns * ROOM_WIDTH - 1,
    height: 2,
  };
}

/**
 * The whole map: from `x = OUTSIDE_X` to one past the corridor's end (its
 * closing east wall), and `MAP_HEIGHT` rows from `y = 0`.
 */
export function mapBounds(world: OfficeWorld): Bounds {
  return {
    x: 0,
    y: 0,
    width: FIRST_SLOT_X + world.corridorColumns * ROOM_WIDTH + 1,
    height: MAP_HEIGHT,
  };
}

/**
 * The starting office: the rec room in slot 0 and the mail room in slot 1,
 * each furnished; the corridor, one column long; the office door. No
 * avatars, `layoutVersion` 0, `nextAvatarNumber` 1, `corridorColumns` 1.
 */
export function createInitialWorld(): OfficeWorld {
  const rec: Room = {
    id: REC_ROOM_ID,
    purpose: 'rec',
    slot: REC_ROOM_SLOT,
    bounds: slotBounds(REC_ROOM_SLOT),
    door: doorTile(REC_ROOM_SLOT),
    closing: false,
  };
  const mail: Room = {
    id: MAIL_ROOM_ID,
    purpose: 'mail',
    slot: MAIL_ROOM_SLOT,
    bounds: slotBounds(MAIL_ROOM_SLOT),
    door: doorTile(MAIL_ROOM_SLOT),
    closing: false,
  };
  const corridorColumns = 1;
  const corridor: Room = {
    id: CORRIDOR_ID,
    purpose: 'corridor',
    slot: null,
    bounds: corridorBounds(corridorColumns),
    door: null,
    closing: false,
  };
  const officeDoor: Furniture = {
    id: 'corridor:officeDoor',
    kind: 'officeDoor',
    roomId: CORRIDOR_ID,
    tile: OFFICE_DOOR_TILE,
  };

  return {
    rooms: [rec, mail, corridor],
    furniture: [...furnishRoom(rec), ...furnishRoom(mail), officeDoor],
    avatars: [],
    layoutVersion: 0,
    nextAvatarNumber: 1,
    corridorColumns,
  };
}
