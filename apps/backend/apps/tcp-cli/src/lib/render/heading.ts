// The scope heading block and the tracker that decides when to emit it.
// ScopeTracker keys purely on the wire event's own (taskId, assignmentId,
// agentId) columns — no client-side joins to decide *when* a heading is due; a
// HeadingInfoProvider supplies the display fields each surface already fetches.

import { StyleBackend } from './style';

/** The identity columns a wire event carries — the heading key. */
export interface Scope {
  taskId: string | null;
  assignmentId: string | null;
  agentId: string | null;
}

/** Display fields for a scope's heading block; any absent field renders `—`. */
export interface HeadingInfo {
  taskId?: string;
  taskShortcode?: string;
  assignmentId?: string;
  assignmentRole?: string;
  assignmentRoleSlug?: string;
  assignmentRoleId?: string;
  assignmentMode?: string;
  assignmentShortcode?: string;
  agentId?: string;
}

/** Resolves a {@link Scope} to its {@link HeadingInfo} — each surface backs this with data it already holds. */
export type HeadingInfoProvider = (scope: Scope) => HeadingInfo;

/** Left-hand label column width — `'Assignment shortcode:'`, the longest label. */
const LABEL_WIDTH = 21;

/**
 * Emits a heading block whenever the `(taskId, assignmentId, agentId)` tuple
 * changes, so an output stream interleaving several agents (e.g. an
 * eavesdropped task, or a consultation) reprints the heading only on an actual
 * scope change, not per line.
 */
export class ScopeTracker {
  private last: string | null = null;

  /** True the first time a scope is seen, or whenever it differs from the last. */
  changed(scope: Scope): boolean {
    const key = `${scope.taskId ?? ''}|${scope.assignmentId ?? ''}|${scope.agentId ?? ''}`;
    if (key === this.last) return false;
    this.last = key;
    return true;
  }
}

/** A label/value pair as one heading line, label padded to its column. */
function field(
  label: string,
  value: string | undefined,
  style: StyleBackend,
): string {
  const shown = value && value.length > 0 ? style.escape(value) : '—';
  return style.paint(
    'heading',
    `${`${label}:`.padEnd(LABEL_WIDTH + 1)} ${shown}`,
  );
}

/**
 * Renders the scope heading block (`docs/prompts/010.5.1` B.2). The two task
 * lines are omitted when there is no task scope (plain chat); the assignment
 * role line combines name and slug.
 */
export class HeadingBlockRenderer {
  render(info: HeadingInfo, style: StyleBackend): string[] {
    const lines: string[] = [];
    if (info.taskId) {
      lines.push(field('Task id', info.taskId, style));
      lines.push(field('Task shortcode', info.taskShortcode, style));
    }
    const role =
      info.assignmentRole && info.assignmentRoleSlug
        ? `${info.assignmentRole} (${info.assignmentRoleSlug})`
        : info.assignmentRole;
    lines.push(field('Assignment id', info.assignmentId, style));
    lines.push(field('Assignment role', role, style));
    lines.push(field('Assignment role id', info.assignmentRoleId, style));
    lines.push(field('Assignment mode', info.assignmentMode, style));
    lines.push(field('Assignment shortcode', info.assignmentShortcode, style));
    lines.push(field('Agent id', info.agentId, style));
    return lines;
  }
}
