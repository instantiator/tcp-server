import type { GameObjects, Scene } from 'phaser';
import { depthOf, tileToScreen } from '../motion/iso';
import type { Tile } from '../world/types';
import { roleColour, shadesOf } from './palette';

/** The body's footprint and height, in pixels. */
const BODY_SIZE = 22;
const BODY_HEIGHT = 26;
/** The head's radius, in pixels. */
const HEAD_RADIUS = 7;
/** The role ring's radius and line width, in pixels. */
const RING_RADIUS = 14;
const RING_LINE_WIDTH = 2;

/**
 * One figure in the office: an `IsoBox` body shaded from its role's colour,
 * with a circular head on top. A role avatar also gets a ring at its feet,
 * marking it as always present rather than tied to one agent. Everything is
 * wrapped in a `Container` so the whole figure moves and depth-sorts as one
 * game object.
 */
export class AvatarSprite {
  readonly avatarId: string;
  private readonly container: GameObjects.Container;

  constructor(
    scene: Scene,
    avatarId: string,
    kind: 'role' | 'agent',
    roleId: string,
    tile: Tile,
  ) {
    this.avatarId = avatarId;

    const shades = shadesOf(roleColour(roleId));
    const body = scene.add.isobox(
      0,
      0,
      BODY_SIZE,
      BODY_HEIGHT,
      shades.top,
      shades.left,
      shades.right,
    );
    const head = scene.add.circle(0, -BODY_HEIGHT, HEAD_RADIUS, shades.top);
    const parts: GameObjects.GameObject[] = [body, head];

    if (kind === 'role') {
      const ring = scene.add.circle(0, 0, RING_RADIUS);
      ring.setStrokeStyle(RING_LINE_WIDTH, shades.top);
      parts.push(ring);
    }

    this.container = scene.add.container(0, 0, parts);
    this.setTilePosition(tile);
  }

  /** Moves the whole figure to a tile: its screen position, and its depth among everything else. */
  setTilePosition(p: { readonly x: number; readonly y: number }): void {
    const { x, y } = tileToScreen(p);
    this.container.setPosition(x, y);
    this.container.setDepth(depthOf(p));
  }

  destroy(): void {
    this.container.destroy();
  }
}
