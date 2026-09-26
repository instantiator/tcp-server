import { Scene, Scenes, type GameObjects } from 'phaser';
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
 * over on `world-changed`; this scene's only job is to draw it and keep the
 * avatars' game objects in step with it by id. Walking comes in a later
 * step — for now every avatar is placed straight at its `location`.
 */
export class TcpCompanyScene extends Scene {
  private cameraController!: CameraController;
  private staticObjects: GameObjects.GameObject[] = [];
  private readonly avatarSprites = new Map<string, AvatarSprite>();
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
    this.syncAvatars(world.avatars);
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

  private syncAvatars(avatars: readonly Avatar[]): void {
    const seen = new Set<string>();

    for (const avatar of avatars) {
      seen.add(avatar.id);
      const existing = this.avatarSprites.get(avatar.id);
      if (existing === undefined) {
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
      } else {
        existing.setTilePosition(avatar.location);
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
