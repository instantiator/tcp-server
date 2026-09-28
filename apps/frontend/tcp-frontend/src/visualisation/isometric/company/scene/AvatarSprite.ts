import type { GameObjects, Scene } from 'phaser';
import { depthOf, tileToScreen } from '../motion/iso';
import type { SelectionTarget } from '../TcpPhaserEventBus';
import { emitTcpEvent } from '../TcpPhaserEventBus';
import type { Tile } from '../world/types';
import { createHitZone } from './hitZone';
import { BOOK_PAGES_COLOUR, roleColour, shadesOf } from './palette';

/** The body's footprint and height, in pixels. */
const BODY_SIZE = 22;
const BODY_HEIGHT = 26;
/** The head's radius, in pixels. */
const HEAD_RADIUS = 7;
/** A role's book: footprint and height, in pixels, with a thin pale block of pages on top. */
const BOOK_SIZE = 16;
const BOOK_HEIGHT = 6;
const PAGES_HEIGHT = 2;
/**
 * The copy an agent holds once it has collected its role: size, and offset in
 * pixels. It floats just above the head, since at the body's side it read as a
 * bump rather than a book (002.02).
 */
const CARRIED_BOOK_SIZE = 8;
const CARRIED_BOOK_HEIGHT = 4;
const CARRIED_BOOK_X = 0;
const CARRIED_BOOK_Y = -44;
/** The hit zone's footprint and its lift above the base tile, in pixels. */
const ZONE_WIDTH = 28;
const ZONE_HEIGHT = 48;
const ZONE_LIFT = 22;
/** A book's smaller hit zone. */
const BOOK_ZONE_SIZE = 22;
const BOOK_ZONE_LIFT = 4;

/**
 * One figure in the office. An agent avatar is an `IsoBox` body shaded from
 * its role's colour, with a circular head on top, and — once it has
 * collected its role — a small book at its side. A role avatar is just a
 * book in the role's colour, so roles never look like agents. Everything is
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
  private readonly zoneLift: number;
  /** Agents only: the role's copy, shown once the avatar carries it. */
  private readonly carriedBook: GameObjects.IsoBox | null;

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
    // Anything drawn flat on the floor must go first in `parts`: a container
    // draws its children in order, so a later floor marker would sit on top
    // of the figure.
    const parts: GameObjects.GameObject[] = [];
    let zoneSize: { width: number; height: number };

    if (kind === 'role') {
      parts.push(
        scene.add.isobox(
          0,
          0,
          BOOK_SIZE,
          BOOK_HEIGHT,
          shades.top,
          shades.left,
          shades.right,
        ),
        scene.add.isobox(
          0,
          -BOOK_HEIGHT,
          BOOK_SIZE,
          PAGES_HEIGHT,
          BOOK_PAGES_COLOUR,
          BOOK_PAGES_COLOUR,
          BOOK_PAGES_COLOUR,
        ),
      );
      this.carriedBook = null;
      this.zoneLift = BOOK_ZONE_LIFT;
      zoneSize = { width: BOOK_ZONE_SIZE, height: BOOK_ZONE_SIZE };
    } else {
      this.carriedBook = scene.add.isobox(
        CARRIED_BOOK_X,
        CARRIED_BOOK_Y,
        CARRIED_BOOK_SIZE,
        CARRIED_BOOK_HEIGHT,
        shades.top,
        shades.left,
        shades.right,
      );
      this.carriedBook.setVisible(false);
      parts.push(
        scene.add.isobox(
          0,
          0,
          BODY_SIZE,
          BODY_HEIGHT,
          shades.top,
          shades.left,
          shades.right,
        ),
        scene.add.circle(0, -BODY_HEIGHT, HEAD_RADIUS, shades.top),
        this.carriedBook,
      );
      this.zoneLift = ZONE_LIFT;
      zoneSize = { width: ZONE_WIDTH, height: ZONE_HEIGHT };
    }

    this.container = scene.add.container(0, 0, parts);
    this.zone = createHitZone(
      scene,
      0,
      0,
      zoneSize.width,
      zoneSize.height,
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

  /** Shows or hides the role's copy an agent carries. Role avatars ignore it. */
  setHasRole(hasRole: boolean): void {
    this.carriedBook?.setVisible(hasRole);
  }

  /** Moves the whole figure, and its hit zone, to a tile. */
  setTilePosition(p: { readonly x: number; readonly y: number }): void {
    const { x, y } = tileToScreen(p);
    const depth = depthOf(p);
    this.container.setPosition(x, y);
    this.container.setDepth(depth);
    this.zone.setPosition(x, y - this.zoneLift);
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
