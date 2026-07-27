import { TcpAgent, TcpAssignmentMode } from '@tcp/shared';
import type { UUID } from 'crypto';

/**
 * Fields required to create a new {@link TcpAgent}.
 *
 * Every agent is created with an assignment. Supply {@link assignmentId} to
 * attach an existing one; omit it and `DbService.createAgent` auto-creates an
 * orphan implement-mode assignment (whose {@link mode} may be overridden here).
 */
export type TcpAgentTemplate = Pick<
  TcpAgent,
  'companyId' | 'roleId' | 'initialPrompt'
> &
  Partial<Pick<TcpAgent, 'requiredToolCalls' | 'assignmentId'>> & {
    /**
     * Mode for the auto-created orphan assignment when {@link assignmentId} is
     * not supplied. Defaults to `implement`.
     */
    mode?: TcpAssignmentMode;

    /**
     * The assignment whose agent is spawning this one (e.g. a consultation),
     * used only when {@link assignmentId} is not supplied. `DbService.createAgent`
     * inherits the parent's `taskId` onto the new orphan assignment and records
     * `parentAssignmentId`, so the new assignment traces back to the task it
     * was spawned for.
     */
    parentAssignmentId?: UUID;
  };
