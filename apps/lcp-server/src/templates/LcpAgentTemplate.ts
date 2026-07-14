import { LcpAgent, LcpAssignmentMode } from '@lcp/shared';

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
  };
