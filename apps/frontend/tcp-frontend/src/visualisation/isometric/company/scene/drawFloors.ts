import type { GameObjects, Scene } from 'phaser';
import {
  FLOOR_DEPTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  tileToScreen,
} from '../motion/iso';
import type { Region, Tile } from '../world/types';
import { FLOOR_COLOURS, GRID_LINE_COLOUR, dim } from './palette';

/** How visible the grid line is over the floor fill. Faint, so it reads as texture, not a border. */
const GRID_LINE_ALPHA = 0.15;

/**
 * Draws every floored tile in `region` as one diamond each, all in a single
 * `Graphics` object so the whole floor is one draw call. A faint grid line
 * on top of each tile helps the grid read without competing with the floor
 * colour underneath it. A tile `isLit` says is unlit is drawn dimmed.
 */
export function drawFloors(
  scene: Scene,
  region: Region,
  isLit: (tile: Tile) => boolean,
): GameObjects.Graphics {
  const graphics = scene.add.graphics();
  graphics.setDepth(FLOOR_DEPTH);

  const halfWidth = TILE_WIDTH / 2;
  const halfHeight = TILE_HEIGHT / 2;

  region.cells.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (cell.floor === null) {
        return;
      }

      const tile = {
        x: region.origin.x + colIndex,
        y: region.origin.y + rowIndex,
      };
      const { x: cx, y: cy } = tileToScreen(tile);

      graphics.beginPath();
      graphics.moveTo(cx, cy - halfHeight);
      graphics.lineTo(cx + halfWidth, cy);
      graphics.lineTo(cx, cy + halfHeight);
      graphics.lineTo(cx - halfWidth, cy);
      graphics.closePath();

      const fill = FLOOR_COLOURS[cell.floor];
      graphics.fillStyle(isLit(tile) ? fill : dim(fill), 1);
      graphics.fillPath();

      graphics.lineStyle(1, GRID_LINE_COLOUR, GRID_LINE_ALPHA);
      graphics.strokePath();
    });
  });

  return graphics;
}
