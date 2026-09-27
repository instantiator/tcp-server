import type { GameObjects, Scene } from 'phaser';
import { depthOf, tileToScreen } from '../motion/iso';
import type { Furniture, FurnitureKind } from '../world/types';
import { FURNITURE_COLOURS } from './palette';

/** One piece of furniture's footprint and height, in pixels. */
interface FurnitureSize {
  readonly size: number;
  readonly height: number;
}

/**
 * Every kind's placeholder size. The office door is drawn almost flat, as a
 * doormat rather than a box, because it is walkable.
 */
export const FURNITURE_SIZES: Record<FurnitureKind, FurnitureSize> = {
  desk: { size: 44, height: 14 },
  whiteboard: { size: 40, height: 30 },
  sofa: { size: 56, height: 12 },
  pigeonholes: { size: 48, height: 36 },
  table: { size: 40, height: 12 },
  officeDoor: { size: 64, height: 2 },
};

/**
 * Draws one placeholder `IsoBox` per piece of furniture, keyed by furniture
 * id so the scene can find and destroy an individual piece later. Typed as
 * `IsoBox` rather than the base `GameObject`, so a caller (a camera follow
 * onto a whiteboard) gets the `Transform` component it needs with no cast.
 */
export function drawFurniture(
  scene: Scene,
  furniture: readonly Furniture[],
): Map<string, GameObjects.IsoBox> {
  const objects = new Map<string, GameObjects.IsoBox>();

  for (const item of furniture) {
    const { x: cx, y: cy } = tileToScreen(item.tile);
    const { size, height } = FURNITURE_SIZES[item.kind];
    const colour = FURNITURE_COLOURS[item.kind];

    const box = scene.add.isobox(cx, cy, size, height, colour, colour, colour);
    box.setDepth(depthOf(item.tile));
    objects.set(item.id, box);
  }

  return objects;
}
