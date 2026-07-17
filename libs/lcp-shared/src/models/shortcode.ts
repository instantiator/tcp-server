import type { LcpAssignmentMode } from './LcpAssignment.model';

/** Zero-pads `index` to (at least) 3 digits — `0` → `'000'`, `1234` → `'1234'`. */
export function formatShortcodeIndex(index: number): string {
  return String(index).padStart(3, '0');
}

/**
 * Builds an assignment's shortcode from its owning task's shortcode, its
 * mode, and its *plan* index — e.g. `000-000-plan`, `000-001-implement`,
 * `000-001-qa`. `planIndex` is not the assignment's own `orderIndex`: it's 0
 * for the planning assignment, an implement step's `orderIndex + 1`, and
 * (for qa/consultee, which aren't themselves in the plan) the plan index of
 * the assignment they review/were spawned from.
 */
export function buildAssignmentShortcode(
  taskShortcode: string,
  mode: LcpAssignmentMode,
  planIndex: number,
): string {
  return `${taskShortcode}-${formatShortcodeIndex(planIndex)}-${mode}`;
}
