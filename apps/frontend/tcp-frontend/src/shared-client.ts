/**
 * Positive control for the `@tcp/shared` import boundary, and the only source
 * file this workspace has until 002.01 scaffolds the application.
 *
 * It proves the *allowed* direction resolves and typechecks: the browser-safe
 * `@tcp/shared/client` export is reachable from the frontend workspace. Its
 * counterpart is `test/fixtures/server-import-must-fail.ts`, which proves the
 * forbidden direction is rejected.
 *
 * Replace this with real application code when the app is scaffolded; keep
 * some import of `@tcp/shared/client` somewhere in `src/` so the positive
 * half of the boundary stays covered.
 */
import type { WireEvent } from '@tcp/shared/client';

/** Narrows a {@link WireEvent} to the persisted-audit variant. */
export const isAuditEvent = (event: WireEvent): boolean =>
  event.type === 'audit';
