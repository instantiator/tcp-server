import type { OfficeWorld } from '../world/types';
import type { CompanySnapshot } from './companySnapshot';
import { applyRoleRules } from './roleRules';

/** Extra context a rule needs beyond the world and the snapshot. */
export interface RuleContext {
  /** True the first time a snapshot arrives: new avatars are placed, not walked in. */
  readonly firstSnapshot: boolean;
}

/**
 * Runs every rule, in the fixed order the plan lays out. Only `roleRules`
 * exists so far; later steps append here rather than re-ordering:
 *
 * 1. roleRules
 * 2. taskRoomRules.open
 * 3. oneToOneRoomRules.open
 * 4. agentAvatarRules
 * 5. avatarTargetRules
 * 6. taskRoomRules.close
 * 7. cleanup
 */
export function applyRules(
  world: OfficeWorld,
  snapshot: CompanySnapshot,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _ctx: RuleContext,
): OfficeWorld {
  return applyRoleRules(world, snapshot);
}
