import { describe, expect, it } from 'vitest';

import type { Tile } from '../world/types';
import { findPath } from './pathfinding';

/** Builds `isWalkable` from string-art rows: `.` is floor, `#` is a wall, anything off the grid is not walkable. */
function isWalkableFromGrid(grid: readonly string[]): (tile: Tile) => boolean {
  return (tile) => {
    const row = grid[tile.y];
    if (row === undefined || tile.x < 0 || tile.x >= row.length) {
      return false;
    }
    return row[tile.x] === '.';
  };
}

/** Every step in a route must move exactly one tile, along one axis. */
function expectOnlyAxisAlignedSteps(from: Tile, route: readonly Tile[]): void {
  let previous = from;
  for (const tile of route) {
    const dx = Math.abs(tile.x - previous.x);
    const dy = Math.abs(tile.y - previous.y);
    expect(dx + dy).toBe(1);
    previous = tile;
  }
}

describe('findPath', () => {
  it('returns an empty route when from equals to', () => {
    const isWalkable = isWalkableFromGrid(['....']);
    expect(findPath({ x: 1, y: 0 }, { x: 1, y: 0 }, isWalkable)).toEqual([]);
  });

  it('goes straight down an open corridor', () => {
    const isWalkable = isWalkableFromGrid(['....']);
    const route = findPath({ x: 0, y: 0 }, { x: 3, y: 0 }, isWalkable);

    expect(route).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('goes around a wall blocking the direct line', () => {
    const grid = ['....', '.##.', '....'];
    const isWalkable = isWalkableFromGrid(grid);
    const from: Tile = { x: 0, y: 1 };
    const to: Tile = { x: 3, y: 1 };
    const route = findPath(from, to, isWalkable);

    expect(route).not.toBeNull();
    const found = route ?? [];
    expect(found.at(-1)).toEqual(to);
    // The wall sits on the direct line, so the shortest route is two tiles
    // longer than the blocked Manhattan distance: one detour row, there and back.
    expect(found.length).toBe(5);
    expectOnlyAxisAlignedSteps(from, found);
    // Every step is a wall-free tile.
    for (const tile of found) {
      expect(isWalkable(tile)).toBe(true);
    }
  });

  it('never moves diagonally, even around obstacles', () => {
    const grid = ['.....', '.###.', '.....', '.###.', '.....'];
    const isWalkable = isWalkableFromGrid(grid);
    const from: Tile = { x: 0, y: 0 };
    const to: Tile = { x: 4, y: 4 };
    const route = findPath(from, to, isWalkable);

    expect(route).not.toBeNull();
    expectOnlyAxisAlignedSteps(from, route ?? []);
  });

  it('finds the shortest route, not just any route', () => {
    const isWalkable = isWalkableFromGrid(['.....', '.....', '.....']);
    const route = findPath({ x: 0, y: 0 }, { x: 2, y: 2 }, isWalkable);

    // With nothing in the way the shortest route is the Manhattan distance.
    expect(route).not.toBeNull();
    expect(route?.length).toBe(4);
  });

  it('returns null when the goal is unreachable', () => {
    const grid = ['.#.', '.#.', '.#.'];
    const isWalkable = isWalkableFromGrid(grid);

    expect(findPath({ x: 0, y: 1 }, { x: 2, y: 1 }, isWalkable)).toBeNull();
  });

  it('returns null when the goal itself is blocked', () => {
    const grid = ['.#.', '...', '...'];
    const isWalkable = isWalkableFromGrid(grid);

    expect(findPath({ x: 1, y: 2 }, { x: 1, y: 0 }, isWalkable)).toBeNull();
  });

  it('still finds a route when the start tile is blocked', () => {
    // The start tile (1,0) is a wall, standing in for a map change that put
    // a wall under an avatar. The search must treat it as walkable anyway.
    const grid = ['.#.', '...', '...'];
    const isWalkable = isWalkableFromGrid(grid);
    const from: Tile = { x: 1, y: 0 };
    const to: Tile = { x: 1, y: 2 };

    expect(isWalkable(from)).toBe(false);

    const route = findPath(from, to, isWalkable);

    expect(route).toEqual([
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ]);
  });

  it('treats every tile outside the grid as unwalkable', () => {
    const isWalkable = isWalkableFromGrid(['..']);
    expect(findPath({ x: 0, y: 0 }, { x: 5, y: 5 }, isWalkable)).toBeNull();
  });
});
