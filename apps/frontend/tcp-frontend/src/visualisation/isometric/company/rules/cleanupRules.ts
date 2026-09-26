import type { Bounds, OfficeWorld, Tile } from '../world/types';
import { furnitureById, removeRoom } from '../world/worldOps';

/** Whether a tile falls inside a room's bounds, walls included. */
function tileInBounds(bounds: Bounds, tile: Tile): boolean {
  return (
    tile.x >= bounds.x &&
    tile.x < bounds.x + bounds.width &&
    tile.y >= bounds.y &&
    tile.y < bounds.y + bounds.height
  );
}

/**
 * Removes rooms that have finished closing, freeing their slot for reuse.
 * A task room goes once nobody still holds its task; a 1:1 room waits for
 * both sides to be gone from it — nobody standing inside, and nobody still
 * walking towards its table — since a route resolves against the world as
 * it is, and pulling the table out from under a walking avatar would strand it.
 */
export function removeClosedRooms(world: OfficeWorld): OfficeWorld {
  let next = world;
  for (const room of world.rooms) {
    if (!room.closing) {
      continue;
    }

    if (room.purpose === 'task') {
      const stillHeld = next.avatars.some(
        (avatar) => avatar.taskId === room.taskId,
      );
      if (!stillHeld) {
        next = removeRoom(next, room.id);
      }
      continue;
    }

    if (room.purpose === 'oneToOne') {
      const someoneInside = next.avatars.some((avatar) =>
        tileInBounds(room.bounds, avatar.location),
      );
      const someoneHeadingIn = next.avatars.some(
        (avatar) =>
          avatar.target.kind === 'furniture' &&
          furnitureById(next, avatar.target.furnitureId)?.roomId === room.id,
      );
      if (!someoneInside && !someoneHeadingIn) {
        next = removeRoom(next, room.id);
      }
    }
  }
  return next;
}
