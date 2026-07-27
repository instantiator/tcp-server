import type { TcpArtifact } from '../models/TcpArtifact';
import type { TcpAssignment } from '../models/TcpAssignment.model';

/**
 * Presentation strings `TaskOrchestrationService` feeds to the agents it
 * dispatches for QA. Kept alongside `prompt-assembly.ts` so all prompt
 * content shares one home (mirrors `PauseAndResumeService`'s consultation
 * prompt suffix and tcp-mcp-tasks' `prompts.jsonc`), and is unit-testable
 * in isolation.
 */

/**
 * Renders an artifact list, one line per entry, as its bare name/filename
 * (`a.value`) — the same string `read_working_file` takes. A QA caller's
 * storage scope already points its working directory at the *target*
 * assignment's working area (read-only), so a path-type artifact needs no
 * further resolution here; `inline-text` shows its literal value directly.
 */
function renderArtifacts(artifacts: TcpArtifact[]): string {
  if (artifacts.length === 0) return '  (none)';
  return artifacts.map((a) => `  - ${a.value}`).join('\n');
}

/**
 * The prompt given to a QA agent: the assignment it is reviewing, the outputs
 * that assignment was expected to produce, and the artifacts the implementing
 * agent actually prepared.
 */
export function renderQaPresentation(
  target: Pick<TcpAssignment, 'prompt' | 'expected' | 'prepared'>,
): string {
  return [
    'You are reviewing another agent’s completed assignment.',
    '',
    'Assignment under review:',
    target.prompt,
    '',
    'Expected outputs:',
    renderArtifacts(target.expected),
    '',
    'Artifacts the agent prepared:',
    renderArtifacts(target.prepared),
    '',
    'Read each prepared artifact by name via `read_working_file` and decide whether it meets the assignment’s needs.',
  ].join('\n');
}

/**
 * The message injected into a rejected implementing agent when it is resumed:
 * explains the prepared work was judged insufficient and quotes the QA
 * feedback so the agent can revise and call `complete_assignment` again.
 */
export function renderQaRejectionMessage(feedback: string | null): string {
  return [
    'Your prepared artifacts were reviewed and judged not yet sufficient for this assignment.',
    '',
    'QA feedback:',
    feedback?.trim() ? feedback.trim() : '(no specific feedback was given)',
    '',
    'Address the feedback, update your working files, then call `complete_assignment` again.',
  ].join('\n');
}
