import type { GameObjects, Scene } from 'phaser';
import {
  FLOOR_DEPTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  tileToScreen,
} from '../motion/iso';
import type { Region } from '../world/types';
import { FLOOR_COLOURS, GRID_LINE_COLOUR } from './palette';

/** How visible the grid line is over the floor fill. Faint, so it reads as texture, not a border. */
const GRID_LINE_ALPHA = 0.15;

/**
 * Draws every floored tile in `region` as one diamond each, all in a single
 * `Graphics` object so the whole floor is one draw call. A faint grid line
 * on top of each tile helps the grid read without competing with the floor
 * colour underneath it.
 */
export function drawFloors(scene: Scene, region: Region): GameObjects.Graphics {
  const graphics = scene.add.graphics();
  graphics.setDepth(FLOOR_DEPTH);

  const halfWidth = TILE_WIDTH / 2;
  const halfHeight = TILE_HEIGHT / 2;

  region.cells.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (cell.floor === null) {
        return;
      }

      const { x: cx, y: cy } = tileToScreen({
        x: region.origin.x + colIndex,
        y: region.origin.y + rowIndex,
      });

      graphics.beginPath();
      graphics.moveTo(cx, cy - halfHeight);
      graphics.lineTo(cx + halfWidth, cy);
      graphics.lineTo(cx, cy + halfHeight);
      graphics.lineTo(cx - halfWidth, cy);
      graphics.closePath();

      graphics.fillStyle(FLOOR_COLOURS[cell.floor], 1);
      graphics.fillPath();

      graphics.lineStyle(1, GRID_LINE_COLOUR, GRID_LINE_ALPHA);
      graphics.strokePath();
    });
  });

  return graphics;
}
