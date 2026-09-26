/*
 * Isometric projection. Step 7 builds the functions; the tile size is fixed
 * here so drawing and walking agree on it.
 */

import type { Tile } from '../world/types';

/** A tile's width on screen, in pixels. Tiles are 2:1 diamonds. */
export const TILE_WIDTH = 64;
/** A tile's height on screen, in pixels. */
export const TILE_HEIGHT = 32;

/**
 * Floors draw below everything else, whatever their screen position would
 * otherwise sort to.
 */
export const FLOOR_DEPTH = -1;

/**
 * Tile space to screen space, for a tile's centre. Fractional tile positions
 * are allowed, because a walking avatar sits between two tiles.
 */
export function tileToScreen(p: { readonly x: number; readonly y: number }): {
  x: number;
  y: number;
} {
  return {
    x: ((p.x - p.y) * TILE_WIDTH) / 2,
    y: ((p.x + p.y) * TILE_HEIGHT) / 2,
  };
}

/** Screen space back to the tile whose diamond contains the point. */
export function screenToTile(s: {
  readonly x: number;
  readonly y: number;
}): Tile {
  const x = Math.round(s.x / TILE_WIDTH + s.y / TILE_HEIGHT);
  const y = Math.round(s.y / TILE_HEIGHT - s.x / TILE_WIDTH);
  // Round can hand back -0, which reads oddly and compares awkwardly in tests.
  return { x: x + 0, y: y + 0 };
}

/**
 * The draw order for a tile position: nearer the viewer sorts later (larger).
 * This is the screen `y` of the tile's centre; `FLOOR_DEPTH` sits below every
 * value this can produce.
 */
export function depthOf(p: { readonly x: number; readonly y: number }): number {
  return ((p.x + p.y) * TILE_HEIGHT) / 2;
}
