import { isNorthSlot, ROOM_HEIGHT } from './layout';
import type { Furniture, Room, Tile } from './types';

/**
 * Room furniture is defined for a north-facing room, in tiles relative to its
 * bounds, then mirrored in `y` for a south room. Column 4 is always the door
 * column; row 1 is the back wall, away from the door.
 */
function roomTile(room: Room, col: number, row: number): Tile {
  const north = room.slot !== null && isNorthSlot(room.slot);
  return {
    x: room.bounds.x + col,
    y: north ? room.bounds.y + row : room.bounds.y + (ROOM_HEIGHT - 1) - row,
  };
}

/** One room-relative desk position, before mirroring. */
interface DeskPosition {
  readonly col: number;
  readonly row: number;
}

/**
 * The order desks fill a task room in, as agents claim them. Room-relative,
 * for a north room; {@link nextDeskTile} mirrors it for a south room.
 */
export const DESK_POSITIONS: readonly DeskPosition[] = [
  { col: 2, row: 2 },
  { col: 6, row: 2 },
  { col: 2, row: 4 },
  { col: 6, row: 4 },
  { col: 1, row: 2 },
  { col: 7, row: 2 },
  { col: 1, row: 4 },
  { col: 7, row: 4 },
];

/** A task room holds at most this many desks. */
export const MAX_DESKS_PER_ROOM = 8;

/** The furniture a freshly created room starts with. Task rooms get desks only as agents claim them. */
export function furnishRoom(room: Room): Furniture[] {
  switch (room.purpose) {
    case 'rec':
      return [
        {
          id: 'rec:sofa:1',
          kind: 'sofa',
          roomId: room.id,
          tile: roomTile(room, 2, 1),
        },
        {
          id: 'rec:sofa:2',
          kind: 'sofa',
          roomId: room.id,
          tile: roomTile(room, 6, 1),
        },
      ];
    case 'mail':
      return [
        {
          id: 'mail:pigeonholes',
          kind: 'pigeonholes',
          roomId: room.id,
          tile: roomTile(room, 4, 1),
        },
      ];
    case 'task':
      return [
        {
          id: `${room.id}:whiteboard`,
          kind: 'whiteboard',
          roomId: room.id,
          tile: roomTile(room, 4, 1),
        },
      ];
    case 'oneToOne':
      return [
        {
          id: `${room.id}:table`,
          kind: 'table',
          roomId: room.id,
          tile: roomTile(room, 4, 3),
        },
      ];
    case 'corridor':
      return [];
  }
}

/**
 * The tile the next desk in `room` would sit on, or `null` once the room is
 * full.
 *
 * ponytail: an avatar with no free desk stands by the whiteboard instead of
 * getting one. If a task ever needs more than {@link MAX_DESKS_PER_ROOM}
 * concurrent avatars, grow the room rather than adding more desk spots here.
 */
export function nextDeskTile(room: Room, desksInRoom: number): Tile | null {
  const position = DESK_POSITIONS[desksInRoom];
  if (position === undefined) {
    return null;
  }
  return roomTile(room, position.col, position.row);
}

/**
 * Every spot in the rec room a role avatar can stand: the interior tiles in
 * row-major order, skipping the door column and the two sofas.
 *
 * ponytail: a company with more roles than this has spots is not placed past
 * the limit. A bigger rec room is the upgrade, not a smarter layout here.
 */
export function roleSpots(recRoom: Room): Tile[] {
  const spots: Tile[] = [];
  for (let row = 1; row <= 5; row += 1) {
    for (let col = 1; col <= 7; col += 1) {
      const isDoorColumn = col === 4;
      const isSofa = row === 1 && (col === 2 || col === 6);
      if (isDoorColumn || isSofa) {
        continue;
      }
      spots.push(roomTile(recRoom, col, row));
    }
  }
  return spots;
}
