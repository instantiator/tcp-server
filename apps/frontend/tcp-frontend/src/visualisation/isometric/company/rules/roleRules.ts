import { roleSpots } from '../world/furnishing';
import { REC_ROOM_ID } from '../world/layout';
import type { OfficeWorld, Tile } from '../world/types';
import { addAvatar, avatarById, roomById, sameTile } from '../world/worldOps';
import type { CompanySnapshot } from './companySnapshot';

/** The rec-room tiles already claimed as another role avatar's target. */
function takenSpots(world: OfficeWorld): Tile[] {
  const spots: Tile[] = [];
  for (const avatar of world.avatars) {
    if (avatar.kind === 'role' && avatar.target.kind === 'tile') {
      spots.push(avatar.target.tile);
    }
  }
  return spots;
}

/**
 * One role avatar per snapshot role, each standing at its own rec-room spot.
 * Drops the avatar for a role that has left the snapshot, then places one
 * for every role that doesn't have an avatar yet, in snapshot order. A role
 * past the rec room's spot ceiling is skipped, not placed.
 */
export function applyRoleRules(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
): OfficeWorld {
  const roleIds = new Set(snapshot.roles.map((role) => role.id));
  const filtered = world.avatars.filter(
    (avatar) => avatar.kind !== 'role' || roleIds.has(avatar.roleId),
  );
  let next: OfficeWorld =
    filtered.length === world.avatars.length
      ? world
      : { ...world, avatars: filtered };

  const recRoom = roomById(next, REC_ROOM_ID);
  if (recRoom === undefined) {
    return next;
  }
  const spots = roleSpots(recRoom);

  for (const role of snapshot.roles) {
    const avatarId = `role:${role.id}`;
    if (avatarById(next, avatarId) !== undefined) {
      continue;
    }

    const taken = takenSpots(next);
    const spot = spots.find(
      (candidate) => !taken.some((claimed) => sameTile(claimed, candidate)),
    );
    if (spot === undefined) {
      continue; // the ceiling: no free spot left in the rec room
    }

    next = addAvatar(next, {
      id: avatarId,
      kind: 'role',
      roleId: role.id,
      agentId: null,
      assignmentId: null,
      taskId: null,
      deskId: null,
      location: spot,
      target: { kind: 'tile', tile: spot },
      placeAtTarget: true,
      hasRole: true,
    });
  }

  return next;
}
