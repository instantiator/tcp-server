import { MAIL_ROOM_ID, oneToOneRoomId, taskRoomId } from '../world/layout';
import type { Avatar, AvatarTarget, OfficeWorld } from '../world/types';
import { furnitureById, updateAvatar } from '../world/worldOps';
import type {
  AgentActivity,
  CompanySnapshot,
  SnapshotAgent,
} from './companySnapshot';

/** The mail room's pigeonholes, by the plan's furniture-id convention. */
const PIGEONHOLES_ID = `${MAIL_ROOM_ID}:pigeonholes`;

/** The avatar's task room's whiteboard, or `undefined` outside a task room. */
function whiteboardTarget(
  world: OfficeWorld,
  avatar: Avatar,
): AvatarTarget | undefined {
  if (avatar.taskId === null) {
    return undefined;
  }
  const id = `${taskRoomId(avatar.taskId)}:whiteboard`;
  return furnitureById(world, id) === undefined
    ? undefined
    : { kind: 'furniture', furnitureId: id };
}

/** The avatar's own desk, or `undefined` when it has none. */
function deskTarget(avatar: Avatar): AvatarTarget | undefined {
  return avatar.deskId === null
    ? undefined
    : { kind: 'furniture', furnitureId: avatar.deskId };
}

/** The target for one activity, trying each fallback in order until one exists. */
function targetFor(
  world: OfficeWorld,
  avatar: Avatar,
  activity: AgentActivity,
): AvatarTarget | undefined {
  switch (activity.kind) {
    case 'working':
      return whiteboardTarget(world, avatar) ?? deskTarget(avatar);
    case 'reviewing': {
      const reviewed = world.avatars.find(
        (other) =>
          other.id !== avatar.id &&
          other.assignmentId === activity.reviewedAssignmentId,
      );
      if (reviewed !== undefined) {
        return { kind: 'avatar', avatarId: reviewed.id };
      }
      return whiteboardTarget(world, avatar) ?? deskTarget(avatar);
    }
    case 'consulting': {
      const tableId = `${oneToOneRoomId(activity.oneToOneId)}:table`;
      return furnitureById(world, tableId) === undefined
        ? undefined
        : { kind: 'furniture', furnitureId: tableId };
    }
    case 'messagingUser':
      return furnitureById(world, PIGEONHOLES_ID) === undefined
        ? undefined
        : { kind: 'furniture', furnitureId: PIGEONHOLES_ID };
    case 'atDesk':
      return deskTarget(avatar) ?? whiteboardTarget(world, avatar);
    case 'finished':
      // Dissociated already, by agentAvatarRules; this avatar is skipped
      // before reaching here because its `agentId` is already null.
      return undefined;
  }
}

/**
 * Points every agent avatar at the place its activity belongs: the
 * whiteboard while working, the avatar it reviews, the 1:1 table while
 * consulting, the pigeonholes while messaging the user, or its own desk.
 * When the right place doesn't exist yet, the avatar keeps its last target
 * rather than being sent somewhere wrong.
 */
export function applyAvatarTargetRules(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  const agentsById = new Map<string, SnapshotAgent>(
    snapshot.agents.map((agent) => [agent.id, agent]),
  );

  let next = world;
  for (const avatar of world.avatars) {
    if (avatar.kind !== 'agent' || avatar.agentId === null) {
      continue;
    }
    const agent = agentsById.get(avatar.agentId);
    if (agent === undefined) {
      continue;
    }

    const target = targetFor(next, avatar, agent.activity);
    if (target !== undefined) {
      next = updateAvatar(next, avatar.id, { target });
    }
  }
  return next;
}
