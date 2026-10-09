import type { GameObjects, Scene } from 'phaser';
import { depthOf, TILE_WIDTH, tileToScreen } from '../motion/iso';
import type { Region, Tile } from '../world/types';
import { WALL_COLOURS, dim } from './palette';

/**
 * A wall's height in pixels. Short on purpose — a wall this low never hides
 * an avatar standing behind it.
 */
export const WALL_HEIGHT = 12;

/**
 * Draws one short `IsoBox` per wall tile in `region`. An `IsoBox` sized
 * `TILE_WIDTH` matches a tile's footprint exactly, and each is depth-sorted
 * by its own screen `y` so nearer walls draw over further ones. A wall
 * `isLit` says is unlit is drawn dimmed.
 */
export function drawWalls(
  scene: Scene,
  region: Region,
  isLit: (tile: Tile) => boolean,
): GameObjects.IsoBox[] {
  const boxes: GameObjects.IsoBox[] = [];

  region.cells.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (!cell.wall || cell.floor === null || cell.floor === 'outside') {
        return;
      }

      const tile = {
        x: region.origin.x + colIndex,
        y: region.origin.y + rowIndex,
      };
      const { x: cx, y: cy } = tileToScreen(tile);
      const base = WALL_COLOURS[cell.floor];
      const lit = isLit(tile);
      const colours = lit
        ? base
        : { top: dim(base.top), left: dim(base.left), right: dim(base.right) };

      const box = scene.add.isobox(
        cx,
        cy,
        TILE_WIDTH,
        WALL_HEIGHT,
        colours.top,
        colours.left,
        colours.right,
      );
      box.setDepth(depthOf(tile));
      boxes.push(box);
    });
  });

  return boxes;
}
