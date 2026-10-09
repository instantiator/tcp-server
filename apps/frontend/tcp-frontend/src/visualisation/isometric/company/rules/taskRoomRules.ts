import { ARCHIVE_BOOKSHELF_ID, taskRoomId } from '../world/layout';
import type { Avatar, OfficeWorld } from '../world/types';
import { addRoom, setRoomClosing, updateAvatar } from '../world/worldOps';
import type { CompanySnapshot, SnapshotTask } from './companySnapshot';

/**
 * Gives every task whose room hasn't been closed a room, furnished with a
 * whiteboard — finished or not, so a finished task's room is there after a
 * reload too, until the user closes it. `addRoom` is already a no-op for a
 * task that has a room, so reference equality holds when nothing is new.
 */
export function openTaskRooms(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  let next = world;
  for (const task of snapshot.tasks) {
    if (task.visualisationClosedAt !== null) {
      continue;
    }
    next = addRoom(next, 'task', taskRoomId(task.id), task.id);
  }
  return next;
}

/**
 * The finishing agent: the room's avatar that most recently let go of an
 * agent, by {@link Avatar.dissociatedSeq}. Falls back to any avatar that
 * still holds one — a task can finish before every avatar has formally
 * dissociated — and to `undefined` when neither applies, so the caller
 * sends everyone out with nobody carrying.
 */
function pickCarrier(candidates: readonly Avatar[]): Avatar | undefined {
  const bySeq = candidates
    .filter((avatar) => avatar.dissociatedSeq !== null)
    .sort((a, b) => (b.dissociatedSeq ?? 0) - (a.dissociatedSeq ?? 0))[0];
  return bySeq ?? candidates.find((avatar) => avatar.agentId !== null);
}

/**
 * Sends every avatar still holding a finished (or vanished) task out to the
 * exit — except, for a task that succeeded, the finishing agent, which
 * carries the task's outputs to the archive bookshelf instead. The room
 * stays open meanwhile: it only starts closing once the user has closed it
 * (`visualisationClosedAt`) or its task has left the snapshot entirely, and
 * is removed later, once cleanup sees it empty.
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
    const task: SnapshotTask | undefined =
      room.taskId === undefined ? undefined : taskById.get(room.taskId);
    const closed = task === undefined || task.visualisationClosedAt !== null;
    if (closed) {
      next = setRoomClosing(next, room.id);
    }
    if (!closed && !task.finished) {
      continue;
    }

    const candidates = next.avatars.filter(
      (avatar) =>
        avatar.taskId === room.taskId && avatar.target.kind !== 'exit',
    );
    // These rules re-run on every pass, so an avatar already carrying keeps
    // the job: the fallback pick clears `agentId`, and would not pick it again.
    const carrier =
      task?.succeeded === true
        ? (candidates.find((avatar) => avatar.carrying === 'outputs') ??
          pickCarrier(candidates))
        : undefined;

    for (const avatar of candidates) {
      next =
        avatar.id === carrier?.id
          ? updateAvatar(next, avatar.id, {
              agentId: null,
              carrying: 'outputs',
              target: { kind: 'furniture', furnitureId: ARCHIVE_BOOKSHELF_ID },
            })
          : updateAvatar(next, avatar.id, {
              agentId: null,
              target: { kind: 'exit' },
            });
    }
  }
  return next;
}
