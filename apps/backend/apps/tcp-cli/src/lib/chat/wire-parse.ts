// Narrowing for untrusted payloads off the wire. Nothing here trusts a field's
// declared type: an SSE payload that doesn't match its contract must degrade to
// a safe default rather than reach the TUI and crash it mid-render.

import type { TaskChangeSummary } from '@tcp/shared';
import type { UUID } from 'crypto';

/** Reads a string field from a record, defaulting to ''. */
export function str(
  obj: Record<string, unknown> | undefined,
  key: string,
): string {
  const value = obj?.[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Parses an assignment's plan index back out of its shortcode's middle segment
 * (`{taskShortcode}-{planIndex}-{mode}`, e.g. `000-001-implement` → `1`) — see
 * `buildAssignmentShortcode`.
 *
 * NB. null for a null or malformed shortcode: an orphan assignment, or a shape
 * this client doesn't recognise.
 */
export function planIndexFromShortcode(
  shortcode: string | null,
): number | null {
  const segment = shortcode?.split('-')[1];
  const index = segment !== undefined ? Number(segment) : NaN;
  return Number.isInteger(index) ? index : null;
}

/**
 * Validates and narrows a task `state_change`'s `payload.summary` into a
 * {@link TaskChangeSummary}, rather than trusting or casting it directly.
 *
 * NB. `null` for a summary missing its required fields.
 */
export function parseTaskChangeSummary(
  data: Record<string, unknown> | undefined,
): TaskChangeSummary | null {
  if (!data || typeof data.id !== 'string' || typeof data.status !== 'string') {
    return null;
  }
  return {
    id: data.id as UUID,
    status: data.status as TaskChangeSummary['status'],
    request: typeof data.request === 'string' ? data.request : '',
    shortcode: typeof data.shortcode === 'string' ? data.shortcode : '',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    completedSteps:
      typeof data.completedSteps === 'number' ? data.completedSteps : 0,
    totalSteps: typeof data.totalSteps === 'number' ? data.totalSteps : 0,
  };
}
