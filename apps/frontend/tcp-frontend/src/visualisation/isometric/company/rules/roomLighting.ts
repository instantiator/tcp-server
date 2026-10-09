import { taskRoomId } from '../world/layout';
import type { Furniture, OfficeWorld, Tile } from '../world/types';
import { tileInBounds } from './cleanupRules';
import type { CompanySnapshot } from './companySnapshot';

/** Which rooms and whiteboards the scene draws lit; everything else is dimmed. */
export interface OfficeLighting {
  /** Room ids. */
  readonly litRooms: ReadonlySet<string>;
  /** Task ids: the whiteboard of each task that is being worked. */
  readonly litBoards: ReadonlySet<string>;
}

/** The task statuses in which agents are, or are about to be, working the board. */
const ACTIVE_BOARD_STATUSES: ReadonlySet<string> = new Set([
  'planning',
  'in-progress',
  'finalising',
]);

/**
 * Works out what is lit: a room while a running agent's avatar stands in it
 * (the corridor always, as it is a thoroughfare), and a task's whiteboard
 * while the task is being worked and isn't paused. Pure, so the scene
 * redraws only when the result changes by value.
 */
export function roomLighting(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeLighting {
  const runningAgents = new Set(
    snapshot.agents
      .filter((agent) => agent.status === 'running')
      .map((agent) => agent.id),
  );
  const runningAvatars = world.avatars.filter(
    (avatar) => avatar.agentId !== null && runningAgents.has(avatar.agentId),
  );

  const litRooms = new Set(
    world.rooms
      .filter(
        (room) =>
          room.purpose === 'corridor' ||
          runningAvatars.some((avatar) =>
            tileInBounds(room.bounds, avatar.location),
          ),
      )
      .map((room) => room.id),
  );

  const litBoards = new Set(
    snapshot.tasks
      .filter(
        (task) =>
          ACTIVE_BOARD_STATUSES.has(task.status) &&
          task.pausedAt === null &&
          world.rooms.some((room) => room.id === taskRoomId(task.id)),
      )
      .map((task) => task.id),
  );

  return { litRooms, litBoards };
}

/**
 * Whether a floor or wall tile is lit: it takes its room's lighting, by the
 * same rule `renderRegion` uses to pick a tile's room (the first room other
 * than the corridor whose bounds hold it). A tile in no such room — the
 * corridor, or the apron outside — is always lit.
 */
export function tileIsLit(
  world: OfficeWorld,
  lighting: OfficeLighting,
  tile: Tile,
): boolean {
  const room = world.rooms.find(
    (candidate) =>
      candidate.purpose !== 'corridor' && tileInBounds(candidate.bounds, tile),
  );
  return room === undefined || lighting.litRooms.has(room.id);
}

/**
 * Whether a piece of furniture is lit: a whiteboard by its task's own
 * lighting, everything else by its room's.
 */
export function furnitureIsLit(
  world: OfficeWorld,
  lighting: OfficeLighting,
  item: Furniture,
): boolean {
  const room = world.rooms.find((candidate) => candidate.id === item.roomId);
  if (item.kind === 'whiteboard' && room?.taskId !== undefined) {
    return lighting.litBoards.has(room.taskId);
  }
  return lighting.litRooms.has(item.roomId);
}
