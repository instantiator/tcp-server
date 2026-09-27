import { SPAWN_TILE, taskRoomId } from '../world/layout';
import type { Avatar, AvatarTarget, OfficeWorld } from '../world/types';
import {
  addAgentAvatar,
  claimDesk,
  roomById,
  updateAvatar,
} from '../world/worldOps';
import type { RuleContext } from './applyRules';
import type { CompanySnapshot, SnapshotAgent } from './companySnapshot';

/** A task room's whiteboard, by the plan's `<roomId>:whiteboard` convention. */
function whiteboardId(taskId: string): string {
  return `${taskRoomId(taskId)}:whiteboard`;
}

/**
 * Where a dissociated avatar should wait: by its desk, or the whiteboard
 * with none free, as long as its task room still exists and isn't closing.
 * Anywhere else — no task, or the room is closing or gone — it heads out.
 */
function dissociatedTarget(world: OfficeWorld, avatar: Avatar): AvatarTarget {
  if (avatar.taskId === null) {
    return { kind: 'exit' };
  }
  const room = roomById(world, taskRoomId(avatar.taskId));
  if (room === undefined || room.closing) {
    return { kind: 'exit' };
  }
  return {
    kind: 'furniture',
    furnitureId: avatar.deskId ?? whiteboardId(avatar.taskId),
  };
}

/**
 * Lets go of an avatar whose agent has finished or has left the snapshot.
 * A task avatar waits by its desk (or the whiteboard, with none free) for
 * the next agent of its role; anyone else — a role has no agent to lose, so
 * this only ever touches consultee, chat and task avatars — walks out.
 */
function dissociateFinishedAgents(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));

  let next = world;
  for (const avatar of world.avatars) {
    if (avatar.kind !== 'agent' || avatar.agentId === null) {
      continue;
    }
    const agent = agentsById.get(avatar.agentId);
    const gone = agent === undefined || agent.activity.kind === 'finished';
    if (!gone) {
      continue;
    }

    next = updateAvatar(next, avatar.id, {
      agentId: null,
      target: dissociatedTarget(next, avatar),
    });
  }
  return next;
}

/** An avatar this agent could take over: same task, same role, waiting, not already leaving. */
function findWaitingAvatar(
  world: OfficeWorld,
  agent: SnapshotAgent,
  taskId: string,
): Avatar | undefined {
  return world.avatars.find(
    (avatar) =>
      avatar.kind === 'agent' &&
      avatar.taskId === taskId &&
      avatar.roleId === agent.roleId &&
      avatar.agentId === null &&
      avatar.target.kind !== 'exit',
  );
}

/** Attaches a task agent: reuse a waiting avatar of its role, or spawn and desk a new one. */
function attachTaskAgent(
  world: OfficeWorld,
  agent: SnapshotAgent,
  taskId: string,
  ctx: RuleContext,
): OfficeWorld {
  const roomId = taskRoomId(taskId);
  const room = roomById(world, roomId);
  if (room === undefined || room.closing) {
    return world; // the room isn't ready yet; try again next snapshot
  }

  const waiting = findWaitingAvatar(world, agent, taskId);
  if (waiting !== undefined) {
    return updateAvatar(world, waiting.id, {
      agentId: agent.id,
      assignmentId: agent.assignmentId,
    });
  }

  const created = addAgentAvatar(world, {
    roleId: agent.roleId,
    agentId: agent.id,
    assignmentId: agent.assignmentId,
    taskId,
    deskId: null,
    location: SPAWN_TILE,
    target: { kind: 'tile', tile: SPAWN_TILE },
    placeAtTarget: ctx.firstSnapshot,
    hasRole: true,
  });
  const claim = claimDesk(created.world, roomId, created.avatarId);
  const target: AvatarTarget = {
    kind: 'furniture',
    furnitureId: claim.deskId ?? whiteboardId(taskId),
  };
  return updateAvatar(claim.world, created.avatarId, { target });
}

/** Attaches a consultee or chat agent: it has no task room, and no desk. */
function attachNoTaskAgent(
  world: OfficeWorld,
  agent: SnapshotAgent,
  ctx: RuleContext,
): OfficeWorld {
  const { world: next } = addAgentAvatar(world, {
    roleId: agent.roleId,
    agentId: agent.id,
    assignmentId: agent.assignmentId,
    taskId: null,
    deskId: null,
    location: SPAWN_TILE,
    target: { kind: 'tile', tile: SPAWN_TILE },
    placeAtTarget: ctx.firstSnapshot,
    hasRole: true,
  });
  return next;
}

/** Gives every unfinished snapshot agent that isn't shown yet its avatar. */
function attachNewAgents(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
  ctx: RuleContext,
): OfficeWorld {
  let next = world;
  for (const agent of snapshot.agents) {
    if (agent.activity.kind === 'finished') {
      continue;
    }
    const shown = next.avatars.some(
      (avatar) => avatar.kind === 'agent' && avatar.agentId === agent.id,
    );
    if (shown) {
      continue;
    }

    next =
      agent.taskId === null
        ? attachNoTaskAgent(next, agent, ctx)
        : attachTaskAgent(next, agent, agent.taskId, ctx);
  }
  return next;
}

/**
 * Keeps agent avatars in step with the snapshot's agents: an avatar whose
 * agent has gone lets go of it, and an agent with no avatar yet gets one —
 * reusing a role-mate's waiting avatar in the same task room where it can,
 * so a task keeps one avatar per role across a chain of agents rather than
 * growing one per agent. Dissociation runs first, so a same-pass handover
 * (the old agent finishes and its replacement arrives in the one snapshot)
 * reuses the avatar the old agent just left behind.
 */
export function applyAgentAvatarRules(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
  ctx: RuleContext,
): OfficeWorld {
  const dissociated = dissociateFinishedAgents(world, snapshot);
  return attachNewAgents(dissociated, snapshot, ctx);
}
