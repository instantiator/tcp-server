import { furnishRoom, MAX_DESKS_PER_ROOM, nextDeskTile } from './furnishing';
import {
  columnOfSlot,
  CORRIDOR_ID,
  corridorBounds,
  doorTile,
  firstFreeSlot,
  MAIL_ROOM_ID,
  REC_ROOM_ID,
  slotBounds,
} from './layout';
import type {
  Avatar,
  AvatarTarget,
  Furniture,
  OfficeWorld,
  Room,
  Tile,
} from './types';

/** Rooms whose slot never changes for the session: they can't be removed. */
const FIXED_ROOM_IDS: readonly string[] = [
  REC_ROOM_ID,
  MAIL_ROOM_ID,
  CORRIDOR_ID,
];

export function roomById(world: OfficeWorld, id: string): Room | undefined {
  return world.rooms.find((room) => room.id === id);
}

export function furnitureById(
  world: OfficeWorld,
  id: string,
): Furniture | undefined {
  return world.furniture.find((item) => item.id === id);
}

export function avatarById(world: OfficeWorld, id: string): Avatar | undefined {
  return world.avatars.find((avatar) => avatar.id === id);
}

/** The `<n>` in a desk's `<roomId>:desk:<n>` id. */
function deskNumber(deskId: string): number {
  const parts = deskId.split(':');
  return Number(parts[parts.length - 1]);
}

/** A room's desks, ordered by the number in their id. */
export function desksInRoom(world: OfficeWorld, roomId: string): Furniture[] {
  return world.furniture
    .filter((item) => item.kind === 'desk' && item.roomId === roomId)
    .sort((a, b) => deskNumber(a.id) - deskNumber(b.id));
}

/**
 * Adds a task or 1:1 room, furnished, in the first free slot. Grows
 * `corridorColumns` and the corridor's bounds when the slot opens a new
 * column. Unchanged if `id` already names a room.
 */
export function addRoom(
  world: OfficeWorld,
  purpose: 'task' | 'oneToOne',
  id: string,
  taskId?: string,
): OfficeWorld {
  if (roomById(world, id) !== undefined) {
    return world;
  }

  const slot = firstFreeSlot(world.rooms);
  const room: Room = {
    id,
    purpose,
    slot,
    bounds: slotBounds(slot),
    door: doorTile(slot),
    closing: false,
    ...(taskId !== undefined ? { taskId } : {}),
  };

  const corridorColumns = Math.max(
    world.corridorColumns,
    columnOfSlot(slot) + 1,
  );
  const rooms = world.rooms.map((existing) =>
    existing.id === CORRIDOR_ID
      ? { ...existing, bounds: corridorBounds(corridorColumns) }
      : existing,
  );

  return {
    ...world,
    rooms: [...rooms, room],
    furniture: [...world.furniture, ...furnishRoom(room)],
    corridorColumns,
    layoutVersion: world.layoutVersion + 1,
  };
}

/**
 * Removes a room and its furniture, and frees any avatar's desk that stood
 * in it. Unchanged for an unknown room, or for the rec, mail or corridor
 * rooms, which are fixed. `corridorColumns` never shrinks.
 */
export function removeRoom(world: OfficeWorld, roomId: string): OfficeWorld {
  if (
    FIXED_ROOM_IDS.includes(roomId) ||
    roomById(world, roomId) === undefined
  ) {
    return world;
  }

  const removedDeskIds = new Set(
    world.furniture
      .filter((item) => item.roomId === roomId && item.kind === 'desk')
      .map((item) => item.id),
  );

  return {
    ...world,
    rooms: world.rooms.filter((room) => room.id !== roomId),
    furniture: world.furniture.filter((item) => item.roomId !== roomId),
    avatars: world.avatars.map((avatar) =>
      avatar.deskId !== null && removedDeskIds.has(avatar.deskId)
        ? { ...avatar, deskId: null }
        : avatar,
    ),
    layoutVersion: world.layoutVersion + 1,
  };
}

/** Marks a room as closing. Unchanged if it is unknown or already closing. */
export function setRoomClosing(
  world: OfficeWorld,
  roomId: string,
): OfficeWorld {
  const room = roomById(world, roomId);
  if (room === undefined || room.closing) {
    return world;
  }
  return {
    ...world,
    rooms: world.rooms.map((existing) =>
      existing.id === roomId ? { ...existing, closing: true } : existing,
    ),
  };
}

function withFurniture(world: OfficeWorld, updated: Furniture): OfficeWorld {
  return {
    ...world,
    furniture: world.furniture.map((item) =>
      item.id === updated.id ? updated : item,
    ),
  };
}

function withAvatarDesk(
  world: OfficeWorld,
  avatarId: string,
  deskId: string,
): OfficeWorld {
  if (avatarById(world, avatarId) === undefined) {
    return world;
  }
  return {
    ...world,
    avatars: world.avatars.map((avatar) =>
      avatar.id === avatarId ? { ...avatar, deskId } : avatar,
    ),
  };
}

/**
 * Gives `avatarId` a desk in `roomId`: reuses the first free one, or adds a
 * new one up to {@link MAX_DESKS_PER_ROOM}. `deskId` is `null` when the room
 * is unknown or already full.
 */
export function claimDesk(
  world: OfficeWorld,
  roomId: string,
  avatarId: string,
): { world: OfficeWorld; deskId: string | null } {
  const room = roomById(world, roomId);
  if (room === undefined) {
    return { world, deskId: null };
  }

  const desks = desksInRoom(world, roomId);
  const free = desks.find((desk) => desk.ownerAvatarId === undefined);
  if (free !== undefined) {
    const claimed: Furniture = { ...free, ownerAvatarId: avatarId };
    return {
      world: withAvatarDesk(
        withFurniture(world, claimed),
        avatarId,
        claimed.id,
      ),
      deskId: claimed.id,
    };
  }

  if (desks.length >= MAX_DESKS_PER_ROOM) {
    return { world, deskId: null };
  }

  const tile = nextDeskTile(room, desks.length);
  if (tile === null) {
    return { world, deskId: null };
  }

  const desk: Furniture = {
    id: `${roomId}:desk:${desks.length + 1}`,
    kind: 'desk',
    roomId,
    tile,
    ownerAvatarId: avatarId,
  };
  const withDesk: OfficeWorld = {
    ...world,
    furniture: [...world.furniture, desk],
    layoutVersion: world.layoutVersion + 1,
  };
  return {
    world: withAvatarDesk(withDesk, avatarId, desk.id),
    deskId: desk.id,
  };
}

/** Frees a desk, and clears `deskId` on any avatar holding it. Unchanged if unknown. */
export function releaseDesk(world: OfficeWorld, deskId: string): OfficeWorld {
  const desk = furnitureById(world, deskId);
  if (desk === undefined || desk.ownerAvatarId === undefined) {
    return world;
  }
  return {
    ...world,
    furniture: world.furniture.map((item) =>
      item.id === deskId ? { ...item, ownerAvatarId: undefined } : item,
    ),
    avatars: world.avatars.map((avatar) =>
      avatar.deskId === deskId ? { ...avatar, deskId: null } : avatar,
    ),
  };
}

/** Adds an avatar. Unchanged if the id already exists. */
export function addAvatar(world: OfficeWorld, avatar: Avatar): OfficeWorld {
  if (avatarById(world, avatar.id) !== undefined) {
    return world;
  }
  return { ...world, avatars: [...world.avatars, avatar] };
}

/** Adds an agent avatar with the next `agent-avatar:<n>` id. */
export function addAgentAvatar(
  world: OfficeWorld,
  fields: Omit<Avatar, 'id' | 'kind'>,
): { world: OfficeWorld; avatarId: string } {
  const avatarId = `agent-avatar:${world.nextAvatarNumber}`;
  const avatar: Avatar = { ...fields, id: avatarId, kind: 'agent' };
  return {
    world: {
      ...world,
      avatars: [...world.avatars, avatar],
      nextAvatarNumber: world.nextAvatarNumber + 1,
    },
    avatarId,
  };
}

/** Two tiles are the same position. */
export function sameTile(a: Tile, b: Tile): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Two avatar targets resolve to the same thing. */
export function sameTarget(a: AvatarTarget, b: AvatarTarget): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'furniture' && b.kind === 'furniture') {
    return a.furnitureId === b.furnitureId;
  }
  if (a.kind === 'avatar' && b.kind === 'avatar') {
    return a.avatarId === b.avatarId;
  }
  if (a.kind === 'tile' && b.kind === 'tile') {
    return sameTile(a.tile, b.tile);
  }
  return true; // both 'exit'
}

/**
 * Patches an avatar. Unchanged if it is unknown, or if the patch leaves
 * every field equal to what it already was — `location` and `target` are
 * compared by value, everything else by identity.
 */
export function updateAvatar(
  world: OfficeWorld,
  avatarId: string,
  patch: Partial<Omit<Avatar, 'id' | 'kind'>>,
): OfficeWorld {
  const avatar = avatarById(world, avatarId);
  if (avatar === undefined) {
    return world;
  }

  const merged: Avatar = { ...avatar, ...patch };
  const unchanged =
    merged.roleId === avatar.roleId &&
    merged.agentId === avatar.agentId &&
    merged.assignmentId === avatar.assignmentId &&
    merged.taskId === avatar.taskId &&
    merged.deskId === avatar.deskId &&
    merged.placeAtTarget === avatar.placeAtTarget &&
    merged.hasRole === avatar.hasRole &&
    sameTile(merged.location, avatar.location) &&
    sameTarget(merged.target, avatar.target);
  if (unchanged) {
    return world;
  }

  return {
    ...world,
    avatars: world.avatars.map((existing) =>
      existing.id === avatarId ? merged : existing,
    ),
  };
}

/** Removes an avatar and frees its desk. Unchanged if unknown. */
export function removeAvatar(
  world: OfficeWorld,
  avatarId: string,
): OfficeWorld {
  const avatar = avatarById(world, avatarId);
  if (avatar === undefined) {
    return world;
  }
  const withoutAvatar: OfficeWorld = {
    ...world,
    avatars: world.avatars.filter((existing) => existing.id !== avatarId),
  };
  return avatar.deskId === null
    ? withoutAvatar
    : releaseDesk(withoutAvatar, avatar.deskId);
}
