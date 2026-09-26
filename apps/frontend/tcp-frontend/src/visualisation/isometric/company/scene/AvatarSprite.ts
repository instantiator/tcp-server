import type { GameObjects, Scene } from 'phaser';
import { depthOf, tileToScreen } from '../motion/iso';
import type { SelectionTarget } from '../TcpPhaserEventBus';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import type { Tile } from '../world/types';
import { createHitZone } from './hitZone';
import { roleColour, shadesOf } from './palette';

/** The body's footprint and height, in pixels. */
const BODY_SIZE = 22;
const BODY_HEIGHT = 26;
/** The head's radius, in pixels. */
const HEAD_RADIUS = 7;
/** The role ring's radius and line width, in pixels. */
const RING_RADIUS = 14;
const RING_LINE_WIDTH = 2;
/** The hit zone's footprint and its lift above the base tile, in pixels. */
const ZONE_WIDTH = 28;
const ZONE_HEIGHT = 48;
const ZONE_LIFT = 22;

/**
 * One figure in the office: an `IsoBox` body shaded from its role's colour,
 * with a circular head on top. A role avatar also gets a ring at its feet,
 * marking it as always present rather than tied to one agent. Everything is
 * wrapped in a `Container` so the whole figure moves and depth-sorts as one
 * game object.
 *
 * A hit zone floats over the figure's visible body, reporting whatever
 * `setSelection` last set — an agent avatar's selection changes to its role
 * once the agent finishes, all without the zone itself being recreated.
 */
export class AvatarSprite {
  readonly avatarId: string;
  private readonly container: GameObjects.Container;
  private readonly zone: GameObjects.Zone;
  private currentSelection: SelectionTarget;
  private hovered = false;

  constructor(
    scene: Scene,
    avatarId: string,
    kind: 'role' | 'agent',
    roleId: string,
    tile: Tile,
  ) {
    this.avatarId = avatarId;
    // Overwritten by the scene's own `setSelection` call immediately after
    // construction; a role selection is the safe default in the meantime.
    this.currentSelection = { kind: 'role', id: roleId };

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
    this.zone = createHitZone(
      scene,
      0,
      0,
      ZONE_WIDTH,
      ZONE_HEIGHT,
      () => this.currentSelection,
    );
    this.zone.on('pointerover', () => {
      this.hovered = true;
    });
    this.zone.on('pointerout', () => {
      this.hovered = false;
    });
    this.setTilePosition(tile);
  }

  /** The figure itself, for a camera follow. */
  get followable(): GameObjects.Container {
    return this.container;
  }

  get selection(): SelectionTarget {
    return this.currentSelection;
  }

  /** What hovering or clicking this avatar now selects. */
  setSelection(target: SelectionTarget): void {
    this.currentSelection = target;
  }

  /** Moves the whole figure, and its hit zone, to a tile. */
  setTilePosition(p: { readonly x: number; readonly y: number }): void {
    const { x, y } = tileToScreen(p);
    const depth = depthOf(p);
    this.container.setPosition(x, y);
    this.container.setDepth(depth);
    this.zone.setPosition(x, y - ZONE_LIFT);
    this.zone.setDepth(depth);
  }

  destroy(): void {
    // The pointer can't send this zone a `pointerout` once it's gone, so a
    // tooltip that was showing for it would otherwise never be told to hide.
    if (this.hovered) {
      emitTcpEvent({ event: 'hover', value: null });
    }
    this.zone.destroy();
    this.container.destroy();
  }
}
