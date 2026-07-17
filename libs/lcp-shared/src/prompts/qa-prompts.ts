import type { LcpArtifact } from '../models/LcpArtifact';
import type { LcpAssignment } from '../models/LcpAssignment.model';
import {
  ArtifactResolutionContext,
  resolveArtifactKey,
} from '../storage/artifact-keys';

/**
 * Presentation strings `TaskOrchestrationService` feeds to the agents it
 * dispatches for QA. Kept alongside `prompt-assembly.ts` so all prompt
 * content shares one home (mirrors `PauseAndResumeService`'s consultation
 * prompt suffix and lcp-mcp-tasks' `prompts.jsonc`), and is unit-testable
 * in isolation.
 */

/**
 * Renders an artifact list, one line per entry: a path-type artifact as its
 * resolved storage key plus how to read it (`read_file` takes a full object
 * key, not the artifact's bare `type` label — showing just `{type}: {value}`,
 * as this used to, left the model to guess a path like
 * `assignment-working-path/guide.md`, which doesn't exist and cannot be
 * corrected from the error alone); `inline-text` shows its literal value,
 * since there's nothing to read.
 */
function renderArtifacts(
  artifacts: LcpArtifact[],
  ctx: ArtifactResolutionContext,
): string {
  if (artifacts.length === 0) return '  (none)';
  return artifacts
    .map((a) => {
      const key = resolveArtifactKey(a, ctx);
      return key
        ? `  - ${a.value} — read via the storage service's read_file tool, path: "${key}"`
        : `  - ${a.value}`;
    })
    .join('\n');
}

/**
 * The prompt given to a QA agent: the assignment it is reviewing, the outputs
 * that assignment was expected to produce, and the artifacts the implementing
 * agent actually prepared. `resolutionContext` resolves each path-type
 * artifact to the storage key `read_file` actually needs (see
 * {@link resolveArtifactKey}).
 */
export function renderQaPresentation(
  target: Pick<LcpAssignment, 'prompt' | 'expected' | 'prepared'>,
  resolutionContext: ArtifactResolutionContext,
): string {
  return [
    'You are reviewing another agent’s completed assignment.',
    '',
    'Assignment under review:',
    target.prompt,
    '',
    'Expected outputs:',
    renderArtifacts(target.expected, resolutionContext),
    '',
    'Artifacts the agent prepared:',
    renderArtifacts(target.prepared, resolutionContext),
    '',
    'Read each prepared artifact (via read_file, using the path given above where one is shown) and decide whether it meets the assignment’s needs.',
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
