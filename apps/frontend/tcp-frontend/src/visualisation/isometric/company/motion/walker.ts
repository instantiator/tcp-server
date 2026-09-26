/*
 * How avatars walk. Step 7 builds the walker itself; these numbers are fixed
 * here so the scene and the tests agree on them.
 */

import type { Tile } from '../world/types';

/** Walking speed, in tiles along a grid axis per second. */
export const WALK_TILES_PER_SECOND = 3;

/** How often a blocked avatar plans a new route, treating other avatars' tiles as walls. */
export const REROUTE_MS = 600;

/**
 * How long an avatar stays blocked before its next step ignores other
 * avatars and walks through them.
 */
// ponytail: a deadlock escape, not avoidance; priority-based yielding if walking through looks wrong
export const GHOST_AFTER_MS = 4000;

/** An avatar's live progress along its route. The scene owns this; the world model doesn't. */
export interface Walker {
  /** Tile-space position. Equals `tile` when standing; between `tile` and `route[0]` while stepping. */
  readonly position: { readonly x: number; readonly y: number };
  /** The tile the walker holds: where it stands, or the tile it is stepping away from. */
  readonly tile: Tile;
  /** Tiles still to walk, next first. Empty once arrived. */
  readonly route: readonly Tile[];
  /** True while moving from `tile` towards `route[0]`. The walker has reserved `route[0]`. */
  readonly stepping: boolean;
  /** How long the walker has been unable to start its next step. 0 when it isn't blocked. */
  readonly blockedMs: number;
}

/** What changed for a walker in one `advanceWalker` call. */
export interface WalkerUpdate {
  readonly walker: Walker;
  /** The walker reached the end of its route in this update. True once per route. */
  readonly arrived: boolean;
  /** Blocking has just crossed another multiple of REROUTE_MS; the scene should plan a new route. */
  readonly needsReplan: boolean;
}

/** A new walker standing still on `tile`, with nowhere to go yet. */
export function createWalker(tile: Tile): Walker {
  return {
    position: { x: tile.x, y: tile.y },
    tile,
    route: [],
    stepping: false,
    blockedMs: 0,
  };
}

/**
 * Where a new route for this walker must start. While stepping, that is
 * `route[0]`, because the walker has already reserved it; otherwise it is
 * the tile the walker is standing on.
 */
export function planningTile(walker: Walker): Tile {
  return walker.stepping ? walker.route[0] : walker.tile;
}

/**
 * Gives the walker a new route, a `findPath` result starting from
 * `planningTile(walker)`. While stepping, the step already under way is kept
 * and the new route follows it; otherwise the new route replaces the old one
 * outright.
 *
 * The time spent blocked carries over. A blocked walker re-plans every
 * `REROUTE_MS`, so clearing it here would stop it ever reaching
 * `GHOST_AFTER_MS`. Only starting a step clears it.
 */
export function setRoute(walker: Walker, route: readonly Tile[]): Walker {
  return {
    ...walker,
    route: walker.stepping ? [walker.route[0], ...route] : route,
  };
}

/**
 * Moves a walker on by `deltaMs`, waiting out or ghosting through a blocked
 * next tile. `isBlocked` answers whether another walker holds or has
 * reserved a tile; this never checks walls itself, since a route only ever
 * comes from `findPath`.
 */
export function advanceWalker(
  walker: Walker,
  deltaMs: number,
  isBlocked: (tile: Tile) => boolean,
): WalkerUpdate {
  if (walker.route.length === 0) {
    return { walker, arrived: false, needsReplan: false };
  }

  if (!walker.stepping) {
    return startOrWait(walker, deltaMs, isBlocked);
  }

  return step(walker, deltaMs);
}

/** The walker is standing still, deciding whether it can start its next step. */
function startOrWait(
  walker: Walker,
  deltaMs: number,
  isBlocked: (tile: Tile) => boolean,
): WalkerUpdate {
  const next = walker.route[0];

  if (isBlocked(next) && walker.blockedMs < GHOST_AFTER_MS) {
    const blockedMs = walker.blockedMs + deltaMs;
    const needsReplan =
      Math.floor(blockedMs / REROUTE_MS) >
      Math.floor(walker.blockedMs / REROUTE_MS);
    return { walker: { ...walker, blockedMs }, arrived: false, needsReplan };
  }

  // The way is clear, or the wait has gone on long enough to ghost through:
  // reserve the next tile and move in this same update.
  return step({ ...walker, stepping: true, blockedMs: 0 }, deltaMs);
}

/** The walker is moving from `tile` towards `route[0]`. */
function step(walker: Walker, deltaMs: number): WalkerUpdate {
  const target = walker.route[0];
  const dx = target.x - walker.position.x;
  const dy = target.y - walker.position.y;
  const remaining = Math.abs(dx) + Math.abs(dy);
  const distance = (WALK_TILES_PER_SECOND * deltaMs) / 1000;

  if (distance >= remaining) {
    // ponytail: leftover distance is dropped; carry it over if walking looks slow at low frame rates
    const route = walker.route.slice(1);
    return {
      walker: {
        ...walker,
        position: { x: target.x, y: target.y },
        tile: target,
        route,
        stepping: false,
      },
      arrived: route.length === 0,
      needsReplan: false,
    };
  }

  const ratio = distance / remaining;
  const position = {
    x: walker.position.x + dx * ratio,
    y: walker.position.y + dy * ratio,
  };
  return {
    walker: { ...walker, position },
    arrived: false,
    needsReplan: false,
  };
}
