import { describe, expect, it } from 'vitest';

import {
  DESK_POSITIONS,
  furnishRoom,
  MAX_DESKS_PER_ROOM,
  nextDeskTile,
  roleSpots,
} from './furnishing';
import { doorTile, slotBounds } from './layout';
import type { Room } from './types';

function roomAt(
  purpose: Room['purpose'],
  slot: number,
  id: string = purpose,
): Room {
  return {
    id,
    purpose,
    slot,
    bounds: slotBounds(slot),
    door: doorTile(slot),
    closing: false,
  };
}

describe('furnishRoom', () => {
  it('gives a north rec room two sofas along the back wall', () => {
    const rec = roomAt('rec', 0);
    expect(furnishRoom(rec)).toEqual([
      { id: 'rec:sofa:1', kind: 'sofa', roomId: 'rec', tile: { x: 4, y: 1 } },
      { id: 'rec:sofa:2', kind: 'sofa', roomId: 'rec', tile: { x: 8, y: 1 } },
    ]);
  });

  it('mirrors the sofas for a south rec room', () => {
    const rec = roomAt('rec', 1);
    expect(furnishRoom(rec)).toEqual([
      { id: 'rec:sofa:1', kind: 'sofa', roomId: 'rec', tile: { x: 4, y: 14 } },
      { id: 'rec:sofa:2', kind: 'sofa', roomId: 'rec', tile: { x: 8, y: 14 } },
    ]);
  });

  it('gives a north mail room pigeonholes at the centre of the back wall', () => {
    const mail = roomAt('mail', 0);
    expect(furnishRoom(mail)).toEqual([
      {
        id: 'mail:pigeonholes',
        kind: 'pigeonholes',
        roomId: 'mail',
        tile: { x: 6, y: 1 },
      },
    ]);
  });

  it('mirrors the pigeonholes for a south mail room', () => {
    const mail = roomAt('mail', 1);
    expect(furnishRoom(mail)).toEqual([
      {
        id: 'mail:pigeonholes',
        kind: 'pigeonholes',
        roomId: 'mail',
        tile: { x: 6, y: 14 },
      },
    ]);
  });

  it('gives a north task room a whiteboard and no desks', () => {
    const task = roomAt('task', 2, 'task:t1');
    expect(furnishRoom(task)).toEqual([
      {
        id: 'task:t1:whiteboard',
        kind: 'whiteboard',
        roomId: 'task:t1',
        tile: { x: 15, y: 1 },
      },
    ]);
  });

  it('mirrors the whiteboard for a south task room', () => {
    const task = roomAt('task', 3, 'task:t1');
    expect(furnishRoom(task)).toEqual([
      {
        id: 'task:t1:whiteboard',
        kind: 'whiteboard',
        roomId: 'task:t1',
        tile: { x: 15, y: 14 },
      },
    ]);
  });

  it('gives a north 1:1 room a table at the centre', () => {
    const oneToOne = roomAt('oneToOne', 2, 'oneToOne:a1');
    expect(furnishRoom(oneToOne)).toEqual([
      {
        id: 'oneToOne:a1:table',
        kind: 'table',
        roomId: 'oneToOne:a1',
        tile: { x: 15, y: 3 },
      },
    ]);
  });

  it('mirrors the table for a south 1:1 room', () => {
    const oneToOne = roomAt('oneToOne', 3, 'oneToOne:a1');
    expect(furnishRoom(oneToOne)).toEqual([
      {
        id: 'oneToOne:a1:table',
        kind: 'table',
        roomId: 'oneToOne:a1',
        tile: { x: 15, y: 12 },
      },
    ]);
  });

  it('furnishes the corridor with nothing', () => {
    const corridor: Room = {
      id: 'corridor',
      purpose: 'corridor',
      slot: null,
      bounds: { x: 1, y: 7, width: 10, height: 2 },
      door: null,
      closing: false,
    };
    expect(furnishRoom(corridor)).toEqual([]);
  });
});

describe('nextDeskTile', () => {
  const task = roomAt('task', 2, 'task:t1');

  it('places the first eight desks at DESK_POSITIONS, mirrored per room orientation', () => {
    const tiles = DESK_POSITIONS.map((_, index) => nextDeskTile(task, index));
    expect(tiles).toEqual([
      { x: 13, y: 2 },
      { x: 17, y: 2 },
      { x: 13, y: 4 },
      { x: 17, y: 4 },
      { x: 12, y: 2 },
      { x: 18, y: 2 },
      { x: 12, y: 4 },
      { x: 18, y: 4 },
    ]);
  });

  it('is null once the room already holds MAX_DESKS_PER_ROOM desks', () => {
    expect(MAX_DESKS_PER_ROOM).toBe(8);
    expect(nextDeskTile(task, 8)).toBeNull();
    expect(nextDeskTile(task, 20)).toBeNull();
  });
});

describe('roleSpots', () => {
  const rec = roomAt('rec', 0);
  const spots = roleSpots(rec);

  it('has 28 spots', () => {
    expect(spots).toHaveLength(28);
  });

  it('keeps the door column clear', () => {
    const doorColumnX = rec.bounds.x + 4;
    expect(spots.some((spot) => spot.x === doorColumnX)).toBe(false);
  });

  it('keeps the two sofa tiles clear', () => {
    const sofaTiles = furnishRoomSofaTiles(rec);
    for (const sofa of sofaTiles) {
      expect(spots.some((spot) => spot.x === sofa.x && spot.y === sofa.y)).toBe(
        false,
      );
    }
  });

  it('places every spot inside the room interior', () => {
    for (const spot of spots) {
      expect(spot.x).toBeGreaterThanOrEqual(rec.bounds.x + 1);
      expect(spot.x).toBeLessThanOrEqual(rec.bounds.x + 7);
      expect(spot.y).toBeGreaterThanOrEqual(rec.bounds.y + 1);
      expect(spot.y).toBeLessThanOrEqual(rec.bounds.y + 5);
    }
  });

  it('has no duplicate spots', () => {
    const keys = spots.map((spot) => `${String(spot.x)},${String(spot.y)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

function furnishRoomSofaTiles(room: Room): { x: number; y: number }[] {
  return furnishRoom(room)
    .filter((item) => item.kind === 'sofa')
    .map((item) => item.tile);
}
