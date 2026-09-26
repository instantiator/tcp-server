import { describe, expect, it } from 'vitest';

import {
  CORRIDOR_Y,
  createInitialWorld,
  mapBounds,
  OUTSIDE_X,
} from '../world/layout';
import { renderRegion } from '../world/renderRegion';
import type { OfficeWorld, Tile } from '../world/types';
import { addRoom } from '../world/worldOps';
import { resolveTarget } from './targetTiles';
import type { TargetEnv } from './targetTiles';

/** The static map's walkability, exactly as the scene builds it for the crowd. */
function isWalkableFromWorld(world: OfficeWorld): (tile: Tile) => boolean {
  const bounds = mapBounds(world);
  const region = renderRegion(
    world,
    bounds.x,
    bounds.y,
    bounds.x + bounds.width - 1,
    bounds.y + bounds.height - 1,
  );
  return (tile: Tile): boolean =>
    region.cells[tile.y - region.origin.y]?.[tile.x - region.origin.x]
      ?.walkable ?? false;
}

/** An env over a real world where nothing is occupied, unless overridden. */
function envFor(
  world: OfficeWorld,
  overrides: Partial<TargetEnv> = {},
): TargetEnv {
  return {
    isWalkable: isWalkableFromWorld(world),
    isFree: () => true,
    liveTileOf: () => undefined,
    ...overrides,
  };
}

describe('resolveTarget', () => {
  describe('tile target', () => {
    it('returns itself, whatever the env says', () => {
      const world = createInitialWorld();
      const env = envFor(world, {
        isWalkable: () => false,
        isFree: () => false,
      });

      expect(
        resolveTarget({ kind: 'tile', tile: { x: 5, y: 5 } }, world, env),
      ).toEqual({ x: 5, y: 5 });
    });
  });

  describe('exit target', () => {
    it('prefers the free outside tile', () => {
      const world = createInitialWorld();
      const blocked: Tile = { x: OUTSIDE_X, y: CORRIDOR_Y };
      const env = envFor(world, {
        isFree: (tile) => !(tile.x === blocked.x && tile.y === blocked.y),
      });

      expect(resolveTarget({ kind: 'exit' }, world, env)).toEqual({
        x: OUTSIDE_X,
        y: CORRIDOR_Y + 1,
      });
    });

    it('picks the first outside tile when both are free', () => {
      const world = createInitialWorld();
      const env = envFor(world);

      expect(resolveTarget({ kind: 'exit' }, world, env)).toEqual({
        x: OUTSIDE_X,
        y: CORRIDOR_Y,
      });
    });

    it('falls back to the first outside tile when neither is free', () => {
      const world = createInitialWorld();
      const env = envFor(world, { isFree: () => false });

      expect(resolveTarget({ kind: 'exit' }, world, env)).toEqual({
        x: OUTSIDE_X,
        y: CORRIDOR_Y,
      });
    });
  });

  describe('furniture target', () => {
    it('returns a walkable tile next to the whiteboard', () => {
      const world = addRoom(createInitialWorld(), 'task', 'task:t1');
      const whiteboard = world.furniture.find(
        (item) => item.kind === 'whiteboard',
      );
      if (whiteboard === undefined) {
        throw new Error('expected a whiteboard');
      }
      const env = envFor(world);

      const goal = resolveTarget(
        { kind: 'furniture', furnitureId: whiteboard.id },
        world,
        env,
      );

      expect(goal).not.toBeNull();
      const found = goal as Tile;
      expect(found).not.toEqual(whiteboard.tile);
      expect(
        Math.abs(found.x - whiteboard.tile.x) +
          Math.abs(found.y - whiteboard.tile.y),
      ).toBe(1);
      expect(env.isWalkable(found)).toBe(true);
    });

    it('skips a tile that isFree rejects', () => {
      const world = addRoom(createInitialWorld(), 'task', 'task:t1');
      const whiteboard = world.furniture.find(
        (item) => item.kind === 'whiteboard',
      );
      if (whiteboard === undefined) {
        throw new Error('expected a whiteboard');
      }
      // The BFS tries +x first; reject it so the search must move on.
      const rejected: Tile = { x: whiteboard.tile.x + 1, y: whiteboard.tile.y };
      const env = envFor(world, {
        isFree: (tile) => !(tile.x === rejected.x && tile.y === rejected.y),
      });

      const goal = resolveTarget(
        { kind: 'furniture', furnitureId: whiteboard.id },
        world,
        env,
      );

      expect(goal).not.toEqual(rejected);
      expect(goal).not.toBeNull();
    });

    it('gives null for an unknown furniture id', () => {
      const world = createInitialWorld();
      const env = envFor(world);

      expect(
        resolveTarget({ kind: 'furniture', furnitureId: 'nope' }, world, env),
      ).toBeNull();
    });
  });

  describe('avatar target', () => {
    it('gives null for an unknown avatar id', () => {
      const world = createInitialWorld();
      const env = envFor(world, { liveTileOf: () => undefined });

      expect(
        resolveTarget({ kind: 'avatar', avatarId: 'nope' }, world, env),
      ).toBeNull();
    });

    it('resolves to a free tile beside the anchor avatar', () => {
      const world = createInitialWorld();
      const anchor: Tile = { x: 3, y: 2 }; // an interior rec-room tile, clear of furniture
      const env = envFor(world, {
        liveTileOf: (avatarId) => (avatarId === 'role:1' ? anchor : undefined),
      });

      const goal = resolveTarget(
        { kind: 'avatar', avatarId: 'role:1' },
        world,
        env,
      );

      expect(goal).not.toBeNull();
      const found = goal as Tile;
      expect(found).not.toEqual(anchor);
      expect(Math.abs(found.x - anchor.x) + Math.abs(found.y - anchor.y)).toBe(
        1,
      );
      expect(env.isWalkable(found)).toBe(true);
    });
  });

  describe('a boxed-in anchor', () => {
    it('gives null when nothing walkable and free surrounds it', () => {
      const world = createInitialWorld();
      const anchor: Tile = { x: 5, y: 5 };
      const env: TargetEnv = {
        isWalkable: () => false,
        isFree: () => true,
        liveTileOf: () => anchor,
      };

      expect(
        resolveTarget({ kind: 'avatar', avatarId: 'boxed-in' }, world, env),
      ).toBeNull();
    });
  });
});
