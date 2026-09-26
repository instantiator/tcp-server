import type {
  AgentDTO,
  AssignmentDTO,
  ConversationDTO,
  RoleDTO,
  TaskDTO,
} from '../../../../api/dtos';

/**
 * What an agent is doing, as far as the office cares. {@link buildCompanySnapshot}
 * works it out from the agent, its assignment, the other assignments and the
 * open enquiries. The first row that matches wins:
 *
 * | # | Condition | Activity |
 * |---|---|---|
 * | 1 | the agent is completed, failed or cancelled, or its assignment is succeeded, failed or cancelled | `finished` |
 * | 2 | an enquiry with status `awaiting_user` names this agent | `messagingUser` |
 * | 3 | the assignment's mode is `chat` | `messagingUser` |
 * | 4 | the assignment's mode is `consultee` | `consulting`, keyed by its own assignment id |
 * | 5 | an active `consultee` assignment has this agent's assignment as its parent | `consulting`, keyed by that assignment's id |
 * | 6 | the mode is `qa` and the agent is running | `reviewing` the assignment's `targetAssignmentId` |
 * | 7 | the agent is running | `working` |
 * | 8 | anything else: idle, or paused for another reason | `atDesk` |
 *
 * Rows 2 and 5 deliberately don't use `agent.pauseReason`. A live agent event
 * patches only `status` into the cached row, so `pauseReason` goes stale; the
 * enquiry and the consultee assignment are both kept current.
 *
 * Rows 1, 4 and 5 test statuses against `ACTIVE_*_STATUSES` from
 * `api/statuses.ts`. Row 2 re-checks the enquiry's status too: a live patch
 * can close an enquiry that is still in the list fetched for `awaiting_user`.
 */
export type AgentActivity =
  | { readonly kind: 'atDesk' }
  | { readonly kind: 'working' }
  | { readonly kind: 'reviewing'; readonly reviewedAssignmentId: string }
  /** `oneToOneId` is the consultee's assignment id, shared by both sides of the consultation. */
  | { readonly kind: 'consulting'; readonly oneToOneId: string }
  | { readonly kind: 'messagingUser' }
  | { readonly kind: 'finished' };

export interface SnapshotRole {
  readonly id: string;
  readonly name: string;
}

export interface SnapshotTask {
  readonly id: string;
  readonly shortcode: string;
  /** The task's prompt. */
  readonly request: string;
  /** The task's status is succeeded, failed or cancelled. */
  readonly finished: boolean;
  /** How many of the task's `implement` assignments have succeeded. */
  readonly step: number;
  /** How many `implement` assignments the task has: its plan's length. */
  readonly steps: number;
}

export interface SnapshotAgent {
  readonly id: string;
  readonly roleId: string;
  readonly assignmentId: string;
  /** From the assignment. `null` for consultee and chat agents, which have no task. */
  readonly taskId: string | null;
  readonly activity: AgentActivity;
}

/** The company, reduced to what the office rules need. */
export interface CompanySnapshot {
  readonly roles: readonly SnapshotRole[];
  /** Every task, finished or not. The rules decide what a finished task means. */
  readonly tasks: readonly SnapshotTask[];
  /** Every agent whose assignment is loaded. An agent whose assignment isn't loaded yet is left out until it is. */
  readonly agents: readonly SnapshotAgent[];
}

/** The live lists a snapshot is built from, exactly as the hooks return them. */
export interface CompanyData {
  readonly roles: readonly RoleDTO[];
  readonly agents: readonly AgentDTO[];
  readonly tasks: readonly TaskDTO[];
  readonly assignments: readonly AssignmentDTO[];
  /** The company's enquiries, fetched for status `awaiting_user`. */
  readonly enquiries: readonly ConversationDTO[];
}

/** Reduces the company's live lists to a {@link CompanySnapshot}. Pure. */
export function buildCompanySnapshot(data: CompanyData): CompanySnapshot {
  throw new Error(
    `Step 5/6: buildCompanySnapshot(${String(data.roles.length)} roles)`,
  );
}
