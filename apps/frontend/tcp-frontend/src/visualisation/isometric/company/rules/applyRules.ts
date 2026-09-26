import type { OfficeWorld } from '../world/types';
import { applyAgentAvatarRules } from './agentAvatarRules';
import { applyAvatarTargetRules } from './avatarTargetRules';
import { removeClosedRooms } from './cleanupRules';
import type { CompanySnapshot } from './companySnapshot';
import { closeOneToOneRooms, openOneToOneRooms } from './oneToOneRoomRules';
import { applyRoleRules } from './roleRules';
import { closeTaskRooms, openTaskRooms } from './taskRoomRules';

/** Extra context a rule needs beyond the world and the snapshot. */
export interface RuleContext {
  /** True the first time a snapshot arrives: new avatars are placed, not walked in. */
  readonly firstSnapshot: boolean;
}

/**
 * Runs every rule, in the fixed order the plan lays out:
 *
 * 1. roleRules
 * 2. taskRoomRules.open
 * 3. oneToOneRoomRules.open
 * 4. agentAvatarRules
 * 5. avatarTargetRules
 * 6. taskRoomRules.close, then oneToOneRoomRules.close
 * 7. cleanup
 *
 * Rule 6 runs after rule 5 on purpose: a finished task's avatars are sent
 * to the exit only after their targets were chosen, so an avatar whose own
 * agent hasn't caught up with the task's finished status still gets
 * overridden rather than left at its whiteboard or desk. From the next
 * pass on, rule 4 skips those avatars because they no longer have an
 * agent, and rule 5 leaves their target — now `exit` — alone.
 */
export function applyRules(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
  ctx: RuleContext,
): OfficeWorld {
  let next = applyRoleRules(world, snapshot);
  next = openTaskRooms(next, snapshot);
  next = openOneToOneRooms(next, snapshot);
  next = applyAgentAvatarRules(next, snapshot, ctx);
  next = applyAvatarTargetRules(next, snapshot);
  next = closeTaskRooms(next, snapshot);
  next = closeOneToOneRooms(next, snapshot);
  next = removeClosedRooms(next);
  return next;
}
