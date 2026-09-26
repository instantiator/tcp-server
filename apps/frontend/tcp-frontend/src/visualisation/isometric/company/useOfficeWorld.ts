import { useCallback, useEffect, useMemo, useReducer } from 'react';
import {
  useCompanyRolesList,
  useLiveAssignmentsList,
  useLiveCompanyAgentsList,
  useLiveCompanyEnquiriesList,
  useLiveCompanyTasksList,
} from '../../../api/hooks';
import { buildCompanySnapshot } from './rules/companySnapshot';
import type { CompanySnapshot } from './rules/companySnapshot';
import { createInitialOfficeState, officeReducer } from './world/officeReducer';
import type { OfficeWorld, Tile } from './world/types';

export interface UseOfficeWorld {
  readonly world: OfficeWorld;
  readonly snapshot: CompanySnapshot | null;
  // Function-typed properties, not method shorthand: these are plain
  // `useCallback` values with no `this`, and method shorthand makes
  // `@typescript-eslint/unbound-method` flag destructuring them.
  readonly avatarArrived: (avatarId: string, tile: Tile) => void;
  readonly avatarExited: (avatarId: string) => void;
}

/**
 * Turns a company's live data into the office the scene draws. Builds a
 * {@link CompanySnapshot} once all five lists have loaded, then lets
 * `officeReducer` work out what changed. The scene reports back through
 * `avatarArrived`/`avatarExited`, which re-run the rules too — a room can
 * only be freed once every avatar that belonged to it has actually left.
 */
export function useOfficeWorld(companyId: string): UseOfficeWorld {
  const roles = useCompanyRolesList(companyId);
  const agents = useLiveCompanyAgentsList(companyId);
  const tasks = useLiveCompanyTasksList(companyId);
  const assignments = useLiveAssignmentsList({ companyId });
  const enquiries = useLiveCompanyEnquiriesList(companyId, 'awaiting_user');

  const snapshot = useMemo<CompanySnapshot | null>(() => {
    if (
      roles.data === undefined ||
      agents.data === undefined ||
      tasks.data === undefined ||
      assignments.data === undefined ||
      enquiries.data === undefined
    ) {
      return null;
    }
    return buildCompanySnapshot({
      roles: roles.data,
      agents: agents.data,
      tasks: tasks.data,
      assignments: assignments.data,
      enquiries: enquiries.data,
    });
  }, [roles.data, agents.data, tasks.data, assignments.data, enquiries.data]);

  const [state, dispatch] = useReducer(
    officeReducer,
    undefined,
    createInitialOfficeState,
  );

  useEffect(() => {
    if (snapshot !== null) {
      dispatch({ type: 'snapshot', snapshot });
    }
  }, [snapshot]);

  const avatarArrived = useCallback((avatarId: string, tile: Tile) => {
    dispatch({ type: 'avatarArrived', avatarId, tile });
  }, []);

  const avatarExited = useCallback((avatarId: string) => {
    dispatch({ type: 'avatarExited', avatarId });
  }, []);

  return {
    world: state.world,
    snapshot: state.snapshot,
    avatarArrived,
    avatarExited,
  };
}
