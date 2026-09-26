import { oneToOneRoomId } from '../world/layout';
import type { OfficeWorld } from '../world/types';
import { addRoom, setRoomClosing } from '../world/worldOps';
import type { CompanySnapshot } from './companySnapshot';

/** Every `oneToOneId` a snapshot agent is consulting under, current agents only. */
function activeOneToOneIds(snapshot: CompanySnapshot): Set<string> {
  const ids = new Set<string>();
  for (const agent of snapshot.agents) {
    if (agent.activity.kind === 'consulting') {
      ids.add(agent.activity.oneToOneId);
    }
  }
  return ids;
}

/**
 * Gives every consultation in progress a 1:1 room with a table, once. Two
 * sides of the same consultation share one `oneToOneId`, so this only ever
 * opens one room per conversation.
 */
export function openOneToOneRooms(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  let next = world;
  for (const id of activeOneToOneIds(snapshot)) {
    next = addRoom(next, 'oneToOne', oneToOneRoomId(id));
  }
  return next;
}

/**
 * Starts closing a 1:1 room once its consultation is no longer active.
 * Cleanup removes it later, once both sides have left.
 */
export function closeOneToOneRooms(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  const activeRoomIds = new Set(
    Array.from(activeOneToOneIds(snapshot), oneToOneRoomId),
  );

  let next = world;
  for (const room of world.rooms) {
    if (room.purpose === 'oneToOne' && !activeRoomIds.has(room.id)) {
      next = setRoomClosing(next, room.id);
    }
  }
  return next;
}
