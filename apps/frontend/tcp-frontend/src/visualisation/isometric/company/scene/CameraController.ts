import type { Cameras, Scene } from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH, tileToScreen } from '../motion/iso';
import type { Bounds, Tile } from '../world/types';

/**
 * Wraps the scene's main camera: fits its scroll bounds to the map, and
 * centres on a tile. Re-fits on every resize, so the padding in
 * {@link fitMap} always matches the current viewport. Panning and following
 * are later steps.
 */
export class CameraController {
  private readonly scene: Scene;
  private readonly camera: Cameras.Scene2D.Camera;
  private lastBounds: Bounds | null = null;
  private listenerRemoved = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.camera = scene.cameras.main;
    scene.scale.on('resize', this.handleResize);
  }

  private readonly handleResize = (): void => {
    if (this.lastBounds !== null) {
      this.fitMap(this.lastBounds);
    }
  };

  /**
   * Sets the camera's scroll bounds to the map's screen rectangle — worked
   * out from `tileToScreen` of its four corner tiles, padded by half a tile
   * so a corner tile's own diamond is fully in view — then padded again by
   * the camera's own viewport size on every side. Without that second
   * padding, a map smaller than the viewport gets pinned to the top-left
   * corner instead of sitting anywhere the camera scrolls to.
   */
  fitMap(bounds: Bounds): void {
    this.lastBounds = bounds;

    const corners = [
      { x: bounds.x, y: bounds.y },
      { x: bounds.x + bounds.width - 1, y: bounds.y },
      { x: bounds.x, y: bounds.y + bounds.height - 1 },
      { x: bounds.x + bounds.width - 1, y: bounds.y + bounds.height - 1 },
    ].map(tileToScreen);

    const halfWidth = TILE_WIDTH / 2;
    const halfHeight = TILE_HEIGHT / 2;
    const minX = Math.min(...corners.map((c) => c.x)) - halfWidth;
    const maxX = Math.max(...corners.map((c) => c.x)) + halfWidth;
    const minY = Math.min(...corners.map((c) => c.y)) - halfHeight;
    const maxY = Math.max(...corners.map((c) => c.y)) + halfHeight;

    const padX = this.camera.width;
    const padY = this.camera.height;
    this.camera.setBounds(
      minX - padX,
      minY - padY,
      maxX - minX + padX * 2,
      maxY - minY + padY * 2,
    );
  }

  /** Scrolls so `tile`'s centre sits in the middle of the viewport. */
  centreOnTile(tile: Tile): void {
    const { x, y } = tileToScreen(tile);
    this.camera.centerOn(x, y);
  }

  /** Removes the resize listener. Safe to call more than once. */
  destroy(): void {
    if (this.listenerRemoved) {
      return;
    }
    this.listenerRemoved = true;
    this.scene.scale.off('resize', this.handleResize);
  }
}
