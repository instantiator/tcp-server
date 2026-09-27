import { Scene, Scenes, type GameObjects } from 'phaser';
import { TILE_HEIGHT, TILE_WIDTH, depthOf, tileToScreen } from '../motion/iso';
import type { CrowdEvent } from '../motion/crowd';
import { Crowd } from '../motion/crowd';
import type { SelectionTarget } from '../TcpPhaserEventBus';
import { emitTcpEvent, offTcpEvent, onTcpEvent } from '../TcpPhaserEventBus';
import { mapBounds } from '../world/layout';
import { renderRegion } from '../world/renderRegion';
import type { Avatar, Bounds, OfficeWorld, Tile } from '../world/types';
import { AvatarSprite } from './AvatarSprite';
import { CameraController } from './CameraController';
import { drawFloors } from './drawFloors';
import { FURNITURE_SIZES, drawFurniture } from './drawFurniture';
import { drawWalls } from './drawWalls';
import { createHitZone } from './hitZone';

/** A whiteboard's hit zone: footprint and lift above the tile centre, in pixels. */
const WHITEBOARD_ZONE_SIZE = 44;
const WHITEBOARD_ZONE_LIFT = 15;
/**
 * How far below its tile's depth a doorway's zone sits, so an avatar
 * standing in the doorway takes the pointer rather than the door.
 */
const DOOR_ZONE_DEPTH_OFFSET = 0.5;

/**
 * The isometric office scene. React works out the whole office and sends it
 * over on `world-changed`; this scene draws it, and a {@link Crowd} walks
 * the avatars through it. The scene itself holds no walking logic — it
 * builds the static map's walkability, hands frames to the crowd, and draws
 * wherever the crowd says an avatar is.
 *
 * It is also where hover, selection and camera control live: avatars and
 * task whiteboards carry hit zones that emit `hover`/`select`, and
 * `camera-pan`/`camera-follow` from React drive the {@link CameraController}.
 */
export class TcpCompanyScene extends Scene {
  private cameraController!: CameraController;
  private staticObjects: GameObjects.GameObject[] = [];
  private readonly avatarSprites = new Map<string, AvatarSprite>();
  private whiteboardsByTaskId = new Map<string, GameObjects.IsoBox>();
  private readonly crowd = new Crowd();
  private lastLayoutVersion: number | null = null;
  private reducedMotion = false;
  private followTarget: SelectionTarget | null = null;
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
    onTcpEvent({ event: 'camera-pan', fn: this.handleCameraPan });
    onTcpEvent({ event: 'camera-follow', fn: this.handleCameraFollow });

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

  private readonly handleCameraPan = (value: {
    dx: number;
    dy: number;
  }): void => {
    const stoppedAFollow = this.cameraController.pan(value.dx, value.dy);
    if (stoppedAFollow) {
      emitTcpEvent({ event: 'follow-stopped', value: undefined });
    }
  };

  private readonly handleCameraFollow = (
    target: SelectionTarget | null,
  ): void => {
    this.followTarget = target;
    this.applyFollow();
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
    offTcpEvent({ event: 'camera-pan', fn: this.handleCameraPan });
    offTcpEvent({ event: 'camera-follow', fn: this.handleCameraFollow });
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

    // A redraw replaces every whiteboard, and avatars come and go on every
    // snapshot — re-resolving the stored target is what keeps a follow on
    // its subject rather than on a game object that no longer exists.
    this.applyFollow();
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
    const { zones, whiteboardsByTaskId } = this.buildWhiteboardZones(
      world,
      furniture,
    );
    this.whiteboardsByTaskId = whiteboardsByTaskId;

    this.staticObjects = [
      drawFloors(this, region),
      ...drawWalls(this, region),
      ...furniture.values(),
      ...zones,
      ...this.buildDescriptionZones(world),
    ];

    if (isFirstDraw) {
      this.cameraController.centreOnTile(mapCentre(bounds));
    }
    this.cameraController.fitMap(bounds);

    this.lastLayoutVersion = world.layoutVersion;
  }

  /**
   * A hit zone for every whiteboard whose room is a task room, targeting
   * that task — plus the whiteboard game object itself, keyed by task id so
   * a `camera-follow` on the task can find it.
   */
  private buildWhiteboardZones(
    world: OfficeWorld,
    furniture: ReadonlyMap<string, GameObjects.IsoBox>,
  ): {
    readonly zones: GameObjects.Zone[];
    readonly whiteboardsByTaskId: Map<string, GameObjects.IsoBox>;
  } {
    const zones: GameObjects.Zone[] = [];
    const whiteboardsByTaskId = new Map<string, GameObjects.IsoBox>();

    for (const item of world.furniture) {
      if (item.kind !== 'whiteboard') {
        continue;
      }
      const room = world.rooms.find(
        (candidate) => candidate.id === item.roomId,
      );
      const taskId = room?.taskId;
      if (
        room === undefined ||
        room.purpose !== 'task' ||
        taskId === undefined
      ) {
        continue;
      }
      const board = furniture.get(item.id);
      if (board === undefined) {
        continue;
      }

      whiteboardsByTaskId.set(taskId, board);

      const { x, y } = tileToScreen(item.tile);
      const zone = createHitZone(
        this,
        x,
        y - WHITEBOARD_ZONE_LIFT,
        WHITEBOARD_ZONE_SIZE,
        WHITEBOARD_ZONE_SIZE,
        () => ({ kind: 'task', id: taskId }),
      );
      zone.setDepth(depthOf(item.tile));
      zones.push(zone);
    }

    return { zones, whiteboardsByTaskId };
  }

  /**
   * Hover-only zones that let furniture and doorways explain themselves in
   * a tooltip. Whiteboards are left out: their own zone opens the task.
   */
  private buildDescriptionZones(world: OfficeWorld): GameObjects.Zone[] {
    const zones: GameObjects.Zone[] = [];

    for (const item of world.furniture) {
      if (item.kind === 'whiteboard') {
        continue;
      }
      const { size, height } = FURNITURE_SIZES[item.kind];
      const { x, y } = tileToScreen(item.tile);
      const target = { kind: 'furniture', id: item.id } as const;
      const zone = createHitZone(
        this,
        x,
        y - height / 2,
        size,
        size / 2 + height,
        () => target,
      );
      zone.setDepth(depthOf(item.tile));
      zones.push(zone);
    }

    for (const room of world.rooms) {
      if (room.door === null) {
        continue;
      }
      const { x, y } = tileToScreen(room.door);
      const target = { kind: 'room', id: room.id } as const;
      const zone = createHitZone(
        this,
        x,
        y,
        TILE_WIDTH,
        TILE_HEIGHT,
        () => target,
      );
      zone.setDepth(depthOf(room.door) - DOOR_ZONE_DEPTH_OFFSET);
      zones.push(zone);
    }

    return zones;
  }

  /**
   * Creates a sprite for each new avatar and destroys one for each avatar
   * gone from the world. Positioning is the crowd's job from here: a new
   * sprite starts at the avatar's last known location only until the next
   * `update` places it where the crowd says it actually is.
   *
   * Every surviving sprite's selection is refreshed too: an agent's avatar
   * selects that agent while it has one, and its role once it doesn't.
   */
  private syncAvatarSprites(avatars: readonly Avatar[]): void {
    const seen = new Set<string>();

    for (const avatar of avatars) {
      seen.add(avatar.id);
      let sprite = this.avatarSprites.get(avatar.id);
      if (sprite === undefined) {
        sprite = new AvatarSprite(
          this,
          avatar.id,
          avatar.kind,
          avatar.roleId,
          avatar.location,
        );
        this.avatarSprites.set(avatar.id, sprite);
      }
      sprite.setHasRole(avatar.hasRole);
      sprite.setSelection(
        avatar.agentId !== null
          ? { kind: 'agent', id: avatar.agentId }
          : { kind: 'role', id: avatar.roleId },
      );
    }

    for (const [id, sprite] of this.avatarSprites) {
      if (!seen.has(id)) {
        sprite.destroy();
        this.avatarSprites.delete(id);
      }
    }
  }

  /**
   * Re-resolves the stored follow target to a game object and tells the
   * camera. A `null` target just stops following; a target that no longer
   * resolves to anything (its avatar or task room is gone) stops following
   * too, but also tells React — the follow it asked for is over now, not
   * merely paused.
   */
  private applyFollow(): void {
    const target = this.followTarget;
    if (target === null) {
      this.cameraController.stopFollow();
      return;
    }

    const followable = this.resolveFollowable(target);
    if (followable === undefined) {
      this.followTarget = null;
      this.cameraController.stopFollow();
      emitTcpEvent({ event: 'follow-stopped', value: undefined });
      return;
    }

    this.cameraController.follow(followable, this.reducedMotion);
  }

  private resolveFollowable(
    target: SelectionTarget,
  ): (GameObjects.Components.Transform & GameObjects.GameObject) | undefined {
    if (target.kind === 'task') {
      return this.whiteboardsByTaskId.get(target.id);
    }
    if (target.kind === 'role') {
      return this.avatarSprites.get(`role:${target.id}`)?.followable;
    }
    for (const sprite of this.avatarSprites.values()) {
      if (
        sprite.selection.kind === 'agent' &&
        sprite.selection.id === target.id
      ) {
        return sprite.followable;
      }
    }
    return undefined;
  }
}

/** The whole map's centre tile, where the camera starts before anything has drawn. */
function mapCentre(bounds: Bounds): Tile {
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
