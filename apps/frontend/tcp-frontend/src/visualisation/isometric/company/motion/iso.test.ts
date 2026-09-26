import { describe, expect, it } from 'vitest';

import type { Tile } from '../world/types';
import {
  TILE_HEIGHT,
  TILE_WIDTH,
  depthOf,
  screenToTile,
  tileToScreen,
} from './iso';

describe('tileToScreen', () => {
  it('places (0,0) at the screen origin', () => {
    expect(tileToScreen({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('moves (1,0) half a tile right and down', () => {
    expect(tileToScreen({ x: 1, y: 0 })).toEqual({ x: 32, y: 16 });
  });

  it('moves (0,1) half a tile left and down', () => {
    expect(tileToScreen({ x: 0, y: 1 })).toEqual({ x: -32, y: 16 });
  });

  it('projects a tile further from the origin', () => {
    expect(tileToScreen({ x: 2, y: 3 })).toEqual({ x: -32, y: 80 });
  });
});

describe('screenToTile', () => {
  it('round-trips every tile in a -3..10 grid through tileToScreen', () => {
    for (let x = -3; x <= 10; x += 1) {
      for (let y = -3; y <= 10; y += 1) {
        const tile: Tile = { x, y };
        expect(screenToTile(tileToScreen(tile))).toEqual(tile);
      }
    }
  });

  it('never returns -0 for either axis', () => {
    const tile = screenToTile(tileToScreen({ x: 0, y: 0 }));
    expect(Object.is(tile.x, -0)).toBe(false);
    expect(Object.is(tile.y, -0)).toBe(false);
  });

  it('still resolves to the same tile 30px right of its centre', () => {
    const centre = tileToScreen({ x: 2, y: 3 });
    expect(screenToTile({ x: centre.x + 30, y: centre.y })).toEqual({
      x: 2,
      y: 3,
    });
  });

  it('still resolves to the same tile 14px below its centre', () => {
    const centre = tileToScreen({ x: 2, y: 3 });
    expect(screenToTile({ x: centre.x, y: centre.y + 14 })).toEqual({
      x: 2,
      y: 3,
    });
  });

  it('resolves to a different tile 40px right of a centre', () => {
    const centre = tileToScreen({ x: 2, y: 3 });
    expect(screenToTile({ x: centre.x + 40, y: centre.y })).not.toEqual({
      x: 2,
      y: 3,
    });
  });
});

describe('depthOf', () => {
  it('grows as x + y grows', () => {
    const near = depthOf({ x: 0, y: 0 });
    const further = depthOf({ x: 1, y: 0 });
    const furthest = depthOf({ x: 1, y: 1 });

    expect(further).toBeGreaterThan(near);
    expect(furthest).toBeGreaterThan(further);
  });

  it('matches the tile centre’s screen y', () => {
    const tile = { x: 3, y: 4 };
    expect(depthOf(tile)).toBe(tileToScreen(tile).y);
    expect(depthOf(tile)).toBe(((tile.x + tile.y) * TILE_HEIGHT) / 2);
  });

  it('is unaffected by TILE_WIDTH', () => {
    // Sanity check that depth tracks the y projection, not the x one.
    expect(TILE_WIDTH).not.toBe(TILE_HEIGHT);
    expect(depthOf({ x: 5, y: 0 })).toBe((5 * TILE_HEIGHT) / 2);
  });
});
