import type { GameObjects, Scene } from 'phaser';
import { depthOf, tileToScreen } from '../motion/iso';
import type { Tile } from '../world/types';
import { FURNITURE_SIZES } from './drawFurniture';
import {
  COMPLETED_TICK_BACKING_COLOUR,
  COMPLETED_TICK_COLOUR,
} from './palette';

/** The tick's backing disc radius, in pixels. */
const TICK_RADIUS = 9;
/** Clear space between the whiteboard's top and the tick's centre, in pixels. */
const TICK_GAP = 12;

/** Where the tick's centre sits on screen: above the whiteboard standing on `tile`. */
export function tickCentre(tile: Tile): { x: number; y: number } {
  const { x, y } = tileToScreen(tile);
  return { x, y: y - FURNITURE_SIZES.whiteboard.height - TICK_GAP };
}

/**
 * Draws a small vector tick on a light disc above the whiteboard on `tile`,
 * the mark of a succeeded task. It sits just in front of the whiteboard in
 * depth so the board never covers it.
 */
export function drawCompletionTick(
  scene: Scene,
  tile: Tile,
): GameObjects.Graphics {
  const { x, y } = tickCentre(tile);
  const graphics = scene.add.graphics();
  graphics.setDepth(depthOf(tile) + 0.5);

  graphics.fillStyle(COMPLETED_TICK_BACKING_COLOUR, 1);
  graphics.fillCircle(x, y, TICK_RADIUS);

  graphics.lineStyle(3, COMPLETED_TICK_COLOUR, 1);
  graphics.beginPath();
  graphics.moveTo(x - 5, y);
  graphics.lineTo(x - 1, y + 4);
  graphics.lineTo(x + 5, y - 4);
  graphics.strokePath();

  return graphics;
}

/** The tick's hit area, centred on {@link tickCentre}. */
export const TICK_ZONE_SIZE = TICK_RADIUS * 2;
