import type { LcpAssignmentMode } from '../models/LcpAssignment.model';

/**
 * Mode-specific instruction prepended to an agent's assignment-presentation
 * prompt part (see lcp-agent's `prompt-assembly.ts`). The agent's mode is its
 * assignment's mode; this text tells the agent what "done" means for that mode
 * and which tool completes it.
 *
 * TODO(010.2.5): the `implement` prompt names the current completion tool
 * `complete_task`; part 5 renames it to `complete_assignment` (and makes the
 * `plan`/`qa` tools live). Until then nothing dispatches `plan`/`qa` agents,
 * so their prompts describe tools that are not yet callable — that is expected.
 */
export const MODE_PROMPTS: Record<LcpAssignmentMode, string> = {
  implement: [
    'You are working an IMPLEMENT assignment. Carry out the assignment prompt below and produce the work it asks for.',
    'Any highlighted materials are listed under "Materials"; they are your starting point, but you may also explore the shared storage service read-only for other material relevant to the work.',
    // TODO(010.2.5): rename `complete_task` → `complete_assignment` here.
    "You MUST finish by doing the work and then calling the `complete_task` tool on the tasks service, passing the artifacts to list as complete. Those artifacts must meet or exceed the assignment's expected outputs listed below.",
    'Call `describe_server` on the tasks service first for the exact tool signature and details.',
  ].join('\n\n'),

  plan: [
    'You are working a PLAN assignment. Design a plan that achieves the task prompt below using the `create_plan` tool on the tasks service.',
    'A plan is an ordered list of assignments, each `{ prompt, role, expected outputs }`. Each assignment automatically receives the outputs of all prior assignments, plus any materials you specify for it.',
    'While planning you may consult other roles and put questions to the user to resolve unknowns before committing the plan.',
    'You MUST call `create_plan` before ending — a narrated plan is not sufficient. Call `describe_server` on the tasks service first for the exact tool signature and details.',
  ].join('\n\n'),

  qa: [
    'You are working a QA assignment. Review the assignment prompt below and the list of prepared artifacts.',
    "Read each artifact via the storage service and verify it meets the assignment's needs and expected outputs.",
    'Then submit your assurance via the `assure_assignment` tool on the tasks service: accept it, or reject it with actionable feedback the implementing agent can act on.',
    'You MUST call `assure_assignment` before ending. Call `describe_server` on the tasks service first for the exact tool signature and details.',
  ].join('\n\n'),
};

/**
 * The tool call an agent in the given mode must make before its run may end
 * (fed into {@link LcpAgent.requiredToolCalls} at creation).
 *
 * TODO(010.2.5): `implement` returns the current `complete_task`; part 5
 * renames it to `complete_assignment`.
 */
export function requiredToolForMode(mode: LcpAssignmentMode): string {
  switch (mode) {
    case 'plan':
      return 'create_plan';
    case 'qa':
      return 'assure_assignment';
    case 'implement':
      // TODO(010.2.5): rename to `complete_assignment`.
      return 'complete_task';
  }
}
