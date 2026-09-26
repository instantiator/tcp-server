import type { Cameras, GameObjects, Scene } from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH, tileToScreen } from '../motion/iso';
import type { Bounds, Tile } from '../world/types';

/** `startFollow`'s lerp for a smooth follow; reduced motion uses `1` (instant) instead. */
const FOLLOW_LERP = 0.1;

/**
 * Wraps the scene's main camera: fits its scroll bounds to the map, centres
 * on a tile, pans by a screen offset, and follows a game object. Re-fits on
 * every resize, so the padding in {@link fitMap} always matches the current
 * viewport.
 */
export class CameraController {
  private readonly scene: Scene;
  private readonly camera: Cameras.Scene2D.Camera;
  private lastBounds: Bounds | null = null;
  private listenerRemoved = false;
  private following = false;

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

  /**
   * Manual panning and following are mutually exclusive: a follow would just
   * fight the scroll this sets. Returns whether a follow was actually
   * running, so the caller knows whether to tell React it stopped.
   */
  pan(dx: number, dy: number): boolean {
    const wasFollowing = this.following;
    this.stopFollow();
    this.camera.scrollX += dx;
    this.camera.scrollY += dy;
    return wasFollowing;
  }

  /**
   * Follows `target`, smoothly under ordinary motion and instantly
   * (`lerp` 1) when `reduced` is true — the same reduced-motion rule the
   * crowd's own walking uses.
   */
  follow(
    target: GameObjects.Components.Transform & GameObjects.GameObject,
    reduced: boolean,
  ): void {
    const lerp = reduced ? 1 : FOLLOW_LERP;
    this.camera.startFollow(target, false, lerp, lerp);
    this.following = true;
  }

  stopFollow(): void {
    if (!this.following) {
      return;
    }
    this.following = false;
    this.camera.stopFollow();
  }

  isFollowing(): boolean {
    return this.following;
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
