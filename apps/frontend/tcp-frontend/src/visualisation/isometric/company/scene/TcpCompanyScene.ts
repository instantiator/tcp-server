import { Scene, Scenes, type GameObjects } from 'phaser';
import type { CrowdEvent } from '../motion/crowd';
import { Crowd } from '../motion/crowd';
import { emitTcpEvent, offTcpEvent, onTcpEvent } from '../TcpPhaserEventBus';
import { mapBounds, REC_ROOM_SLOT, slotBounds } from '../world/layout';
import { renderRegion } from '../world/renderRegion';
import type { Avatar, OfficeWorld, Tile } from '../world/types';
import { AvatarSprite } from './AvatarSprite';
import { CameraController } from './CameraController';
import { drawFloors } from './drawFloors';
import { drawFurniture } from './drawFurniture';
import { drawWalls } from './drawWalls';

/**
 * The isometric office scene. React works out the whole office and sends it
 * over on `world-changed`; this scene draws it, and a {@link Crowd} walks
 * the avatars through it. The scene itself holds no walking logic — it
 * builds the static map's walkability, hands frames to the crowd, and draws
 * wherever the crowd says an avatar is.
 */
export class TcpCompanyScene extends Scene {
  private cameraController!: CameraController;
  private staticObjects: GameObjects.GameObject[] = [];
  private readonly avatarSprites = new Map<string, AvatarSprite>();
  private readonly crowd = new Crowd();
  private lastLayoutVersion: number | null = null;
  private reducedMotion = false;
  private listenersRemoved = false;

  constructor() {
    super({ key: 'TcpCompanyScene' });
  }

  create(): void {
    this.cameraController = new CameraController(this);

    onTcpEvent({ event: 'world-changed', fn: this.handleWorldChanged });
    onTcpEvent({
      event: 'motion-preference',
      fn: this.handleMotionPreference,
    });

    this.events.once(Scenes.Events.SHUTDOWN, this.removeListeners);
    this.events.once(Scenes.Events.DESTROY, this.removeListeners);

    emitTcpEvent({ event: 'scene-ready', value: undefined });
  }

  private readonly handleWorldChanged = (world: OfficeWorld): void => {
    this.syncWorld(world);
  };

  private readonly handleMotionPreference = (value: {
    reduced: boolean;
  }): void => {
    this.reducedMotion = value.reduced;
  };

  /** Removes exactly the listeners this scene registered. Safe to call more than once. */
  private readonly removeListeners = (): void => {
    if (this.listenersRemoved) {
      return;
    }
    this.listenersRemoved = true;
    offTcpEvent({ event: 'world-changed', fn: this.handleWorldChanged });
    offTcpEvent({
      event: 'motion-preference',
      fn: this.handleMotionPreference,
    });
    this.cameraController.destroy();
  };

  private syncWorld(world: OfficeWorld): void {
    if (
      this.lastLayoutVersion === null ||
      this.lastLayoutVersion !== world.layoutVersion
    ) {
      this.redrawStatic(world);
    }

    const isWalkable = buildIsWalkable(world);
    const events = this.crowd.sync(world, isWalkable, this.reducedMotion);

    this.syncAvatarSprites(world.avatars);

    for (const event of events) {
      this.emitCrowdEvent(event);
    }
  }

  update(_time: number, delta: number): void {
    const events = this.crowd.tick(delta);

    for (const [id, sprite] of this.avatarSprites) {
      const position = this.crowd.positionOf(id);
      if (position !== undefined) {
        sprite.setTilePosition(position);
      }
    }

    for (const event of events) {
      this.emitCrowdEvent(event);
    }
  }

  private emitCrowdEvent(event: CrowdEvent): void {
    if (event.kind === 'arrived') {
      emitTcpEvent({
        event: 'avatar-arrived',
        value: { avatarId: event.avatarId, tile: event.tile },
      });
    } else {
      emitTcpEvent({
        event: 'avatar-exited',
        value: { avatarId: event.avatarId },
      });
    }
  }

  private redrawStatic(world: OfficeWorld): void {
    const isFirstDraw = this.lastLayoutVersion === null;

    this.staticObjects.forEach((object) => object.destroy());

    const bounds = mapBounds(world);
    const region = renderRegion(
      world,
      bounds.x,
      bounds.y,
      bounds.x + bounds.width - 1,
      bounds.y + bounds.height - 1,
    );

    const furniture = drawFurniture(this, world.furniture);
    this.staticObjects = [
      drawFloors(this, region),
      ...drawWalls(this, region),
      ...furniture.values(),
    ];

    if (isFirstDraw) {
      this.cameraController.centreOnTile(recRoomCentre());
    }
    this.cameraController.fitMap(bounds);

    this.lastLayoutVersion = world.layoutVersion;
  }

  /**
   * Creates a sprite for each new avatar and destroys one for each avatar
   * gone from the world. Positioning is the crowd's job from here: a new
   * sprite starts at the avatar's last known location only until the next
   * `update` places it where the crowd says it actually is.
   */
  private syncAvatarSprites(avatars: readonly Avatar[]): void {
    const seen = new Set<string>();

    for (const avatar of avatars) {
      seen.add(avatar.id);
      if (!this.avatarSprites.has(avatar.id)) {
        this.avatarSprites.set(
          avatar.id,
          new AvatarSprite(
            this,
            avatar.id,
            avatar.kind,
            avatar.roleId,
            avatar.location,
          ),
        );
      }
    }

    for (const [id, sprite] of this.avatarSprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.avatarSprites.delete(id);
      }
    }
  }
}

/** The rec room's centre tile, where the camera starts before anything else has drawn. */
function recRoomCentre(): Tile {
  const bounds = slotBounds(REC_ROOM_SLOT);
  return {
    x: bounds.x + Math.floor(bounds.width / 2),
    y: bounds.y + Math.floor(bounds.height / 2),
  };
}

/** The static map's walkability, read from a region spanning the whole map. */
function buildIsWalkable(world: OfficeWorld): (tile: Tile) => boolean {
  const bounds = mapBounds(world);
  const region = renderRegion(
    world,
    bounds.x,
    bounds.y,
    bounds.x + bounds.width - 1,
    bounds.y + bounds.height - 1,
  );
  return (tile: Tile): boolean =>
    region.cells[tile.y - region.origin.y]?.[tile.x - region.origin.x]
      ?.walkable ?? false;
}
