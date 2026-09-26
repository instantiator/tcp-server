import { taskRoomId } from '../world/layout';
import type { OfficeWorld } from '../world/types';
import { addRoom, setRoomClosing, updateAvatar } from '../world/worldOps';
import type { CompanySnapshot } from './companySnapshot';

/**
 * Gives every unfinished task a room, furnished with a whiteboard. A
 * finished task never gets one, including the first time it is seen.
 * `addRoom` is already a no-op for a task that has a room, so reference
 * equality holds when nothing is new.
 */
export function openTaskRooms(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  let next = world;
  for (const task of snapshot.tasks) {
    if (task.finished) {
      continue;
    }
    next = addRoom(next, 'task', taskRoomId(task.id), task.id);
  }
  return next;
}

/**
 * Starts closing a task room once its task is finished or has left the
 * snapshot entirely, and sends every avatar still holding that task out to
 * the exit. The room itself is removed later, once cleanup sees it empty.
 */
export function closeTaskRooms(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  const taskById = new Map(snapshot.tasks.map((task) => [task.id, task]));

  let next = world;
  for (const room of world.rooms) {
    if (room.purpose !== 'task') {
      continue;
    }
    const task =
      room.taskId === undefined ? undefined : taskById.get(room.taskId);
    const shouldClose = task === undefined || task.finished;
    if (!shouldClose) {
      continue;
    }

    next = setRoomClosing(next, room.id);
    for (const avatar of next.avatars) {
      if (avatar.taskId === room.taskId && avatar.target.kind !== 'exit') {
        next = updateAvatar(next, avatar.id, {
          agentId: null,
          target: { kind: 'exit' },
        });
      }
    }
  }
  return next;
}
