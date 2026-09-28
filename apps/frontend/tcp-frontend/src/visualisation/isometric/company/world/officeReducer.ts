import { applyRules } from '../rules/applyRules';
import type { CompanySnapshot } from '../rules/companySnapshot';
import { ARCHIVE_BOOKSHELF_ID, createInitialWorld } from './layout';
import type { Avatar, OfficeWorld, Tile } from './types';
import { avatarById, removeAvatar, updateAvatar } from './worldOps';

/** The office reducer's state: the world, and the snapshot the rules last saw. */
export interface OfficeState {
  readonly world: OfficeWorld;
  /** `null` until the first snapshot arrives. */
  readonly snapshot: CompanySnapshot | null;
}

/** What can change the office. */
export type OfficeAction =
  | { readonly type: 'snapshot'; readonly snapshot: CompanySnapshot }
  | {
      readonly type: 'avatarArrived';
      readonly avatarId: string;
      readonly tile: Tile;
    }
  | { readonly type: 'avatarExited'; readonly avatarId: string };

/** A fresh office: the starting world, and no snapshot seen yet. */
export function createInitialOfficeState(): OfficeState {
  return { world: createInitialWorld(), snapshot: null };
}

/**
 * `{ hasRole: true }` when the arriving avatar's target was its own role's
 * book — the pickup stop `avatarTargetRules` sends an unrolled avatar to —
 * so it now carries its role. `{}` otherwise, so an arrival anywhere else
 * leaves `hasRole` as it was.
 */
function arrivedAtRolePatch(
  world: OfficeWorld,
  avatarId: string,
): Partial<Pick<Avatar, 'hasRole'>> {
  const avatar = avatarById(world, avatarId);
  if (avatar === undefined) {
    return {};
  }
  const target = avatar.target;
  return target.kind === 'avatar' && target.avatarId === `role:${avatar.roleId}`
    ? { hasRole: true }
    : {};
}

/**
 * `{ carrying: null, target: { kind: 'exit' } }` when the arriving avatar
 * was carrying a task's outputs to the archive bookshelf and has now
 * reached it — its job done, it heads for the door. `{}` otherwise.
 */
function arrivedAtBookshelfPatch(
  world: OfficeWorld,
  avatarId: string,
): Partial<Pick<Avatar, 'carrying' | 'target'>> {
  const avatar = avatarById(world, avatarId);
  if (avatar === undefined || avatar.carrying !== 'outputs') {
    return {};
  }
  const target = avatar.target;
  return target.kind === 'furniture' &&
    target.furnitureId === ARCHIVE_BOOKSHELF_ID
    ? { carrying: null, target: { kind: 'exit' } }
    : {};
}

/**
 * Applies one action, then re-runs the rules so the world catches up with
 * whatever changed. Returns the same state object when nothing did.
 */
export function officeReducer(
  state: OfficeState,
  action: OfficeAction,
): OfficeState {
  if (action.type === 'snapshot') {
    const world = applyRules(state.world, action.snapshot, {
      firstSnapshot: state.snapshot === null,
    });
    if (world === state.world && action.snapshot === state.snapshot) {
      return state;
    }
    return { world, snapshot: action.snapshot };
  }

  const worldAfterAction =
    action.type === 'avatarArrived'
      ? updateAvatar(state.world, action.avatarId, {
          location: action.tile,
          ...arrivedAtRolePatch(state.world, action.avatarId),
          ...arrivedAtBookshelfPatch(state.world, action.avatarId),
        })
      : removeAvatar(state.world, action.avatarId);

  const world =
    state.snapshot === null
      ? worldAfterAction
      : applyRules(worldAfterAction, state.snapshot, { firstSnapshot: false });

  if (world === state.world) {
    return state;
  }
  return { world, snapshot: state.snapshot };
}
