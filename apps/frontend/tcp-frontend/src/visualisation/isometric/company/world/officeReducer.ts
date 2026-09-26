import { applyRules } from '../rules/applyRules';
import type { CompanySnapshot } from '../rules/companySnapshot';
import { createInitialWorld } from './layout';
import type { OfficeWorld, Tile } from './types';
import { removeAvatar, updateAvatar } from './worldOps';

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
      ? updateAvatar(state.world, action.avatarId, { location: action.tile })
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
