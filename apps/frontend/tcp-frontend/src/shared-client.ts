/**
 * Positive control for the `@tcp/shared` import boundary.
 *
 * It proves the *allowed* direction resolves, typechecks **and bundles**: the
 * browser-safe `@tcp/shared/client` export is reachable from the frontend
 * workspace. Its counterpart is `test/fixtures/server-import-must-fail.ts`,
 * which proves the forbidden direction is rejected.
 *
 * `agentEventsChannel` is imported as a *value* on purpose. A type-only import
 * is erased before the bundler ever sees it, so it would prove nothing about
 * Vite's ability to resolve a `.ts` file behind the package's `exports` map
 * through a workspace symlink — which is exactly the resolution this control
 * exists to cover.
 *
 * Keep a value import of `@tcp/shared/client` reachable from the entry point,
 * or this control stops testing anything.
 */
import { agentEventsChannel, type WireEvent } from '@tcp/shared/client';

/** Narrows a {@link WireEvent} to the persisted-audit variant. */
export const isAuditEvent = (event: WireEvent): boolean =>
  event.type === 'audit';

/** The SSE/Redis channel an agent's events are published on. */
export const channelForAgent = (agentId: string): string =>
  agentEventsChannel(agentId);
