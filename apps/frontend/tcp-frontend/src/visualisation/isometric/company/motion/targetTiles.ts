/*
 * Turning an avatar's target into an actual tile to walk to. The world model
 * only says what an avatar is heading for (a piece of furniture, another
 * avatar, a fixed tile, or the door); this is where that turns into a real
 * destination, given who else is standing where right now.
 */

import { CORRIDOR_Y, OUTSIDE_X } from '../world/layout';
import type { AvatarTarget, OfficeWorld, Tile } from '../world/types';
import { furnitureById, sameTile } from '../world/worldOps';

/**
 * What resolving a target needs to know about the live world: which tiles
 * the static map allows, which tiles nobody has already taken, and where
 * another avatar is standing right now.
 */
export interface TargetEnv {
  /** The static map only: floors, walls, furniture. */
  readonly isWalkable: (tile: Tile) => boolean;
  /** No other avatar holds, reserves or has claimed this tile. */
  readonly isFree: (tile: Tile) => boolean;
  readonly liveTileOf: (avatarId: string) => Tile | undefined;
}

// Fixed order so a search from the same anchor always finds tiles the same way.
const NEIGHBOUR_OFFSETS: readonly Tile[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/** A search gives up rather than scanning an unbounded map. */
const MAX_VISITED_TILES = 200;

function tileKey(tile: Tile): string {
  return `${tile.x},${tile.y}`;
}

/**
 * The nearest tile to `anchor`, other than `anchor` itself, that is walkable
 * and free. `anchor` is expanded even when it isn't itself walkable, because
 * furniture and a standing avatar both sit on tiles nothing else can stand
 * on. Everything found beyond it only continues being searched through if it
 * is walkable.
 */
function nearestFreeTile(anchor: Tile, env: TargetEnv): Tile | null {
  const visited = new Set<string>([tileKey(anchor)]);
  const queue: Tile[] = [anchor];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }

    if (!sameTile(current, anchor) && !env.isWalkable(current)) {
      continue;
    }

    for (const offset of NEIGHBOUR_OFFSETS) {
      const neighbour: Tile = {
        x: current.x + offset.x,
        y: current.y + offset.y,
      };
      const key = tileKey(neighbour);
      if (visited.has(key)) {
        continue;
      }
      if (visited.size >= MAX_VISITED_TILES) {
        return null;
      }
      visited.add(key);

      if (env.isWalkable(neighbour) && env.isFree(neighbour)) {
        return neighbour;
      }
      queue.push(neighbour);
    }
  }

  return null;
}

/** The outside tile a walker should head for: the first of the two that is free, else the first. */
function resolveExit(env: TargetEnv): Tile {
  const first: Tile = { x: OUTSIDE_X, y: CORRIDOR_Y };
  const second: Tile = { x: OUTSIDE_X, y: CORRIDOR_Y + 1 };
  if (env.isFree(first)) {
    return first;
  }
  return env.isFree(second) ? second : first;
}

/**
 * Turns an avatar's target into the tile it should walk to. `null` means the
 * target can't be resolved right now — an unknown furniture or avatar id, or
 * an anchor with nowhere free around it — and the caller should retry later
 * rather than treat it as a real destination.
 */
export function resolveTarget(
  target: AvatarTarget,
  world: OfficeWorld,
  env: TargetEnv,
): Tile | null {
  switch (target.kind) {
    case 'tile':
      return target.tile;
    case 'exit':
      return resolveExit(env);
    case 'furniture': {
      const furniture = furnitureById(world, target.furnitureId);
      return furniture === undefined
        ? null
        : nearestFreeTile(furniture.tile, env);
    }
    case 'avatar': {
      const anchor = env.liveTileOf(target.avatarId);
      return anchor === undefined ? null : nearestFreeTile(anchor, env);
    }
  }
}
