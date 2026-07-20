import { LcpAgent, LcpAssignmentMode } from '@lcp/shared';
import type { UUID } from 'crypto';

/**
 * Fields required to create a new {@link LcpAgent}.
 *
 * Every agent is created with an assignment. Supply {@link assignmentId} to
 * attach an existing one; omit it and `DbService.createAgent` auto-creates an
 * orphan implement-mode assignment (whose {@link mode} may be overridden here).
 */
export type LcpAgentTemplate = Pick<
  LcpAgent,
  'companyId' | 'roleId' | 'initialPrompt'
> &
  Partial<Pick<LcpAgent, 'requiredToolCalls' | 'assignmentId'>> & {
    /**
     * Mode for the auto-created orphan assignment when {@link assignmentId} is
     * not supplied. Defaults to `implement`.
     */
    mode?: LcpAssignmentMode;

    /**
     * The assignment whose agent is spawning this one (e.g. a consultation),
     * used only when {@link assignmentId} is not supplied. `DbService.createAgent`
     * inherits the parent's `taskId` onto the new orphan assignment and records
     * `parentAssignmentId`, so the new assignment traces back to the task it
     * was spawned for.
     */
    parentAssignmentId?: UUID;
  };
