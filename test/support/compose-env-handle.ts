import type { StartedDockerComposeEnvironment } from 'testcontainers';

/**
 * Passes the started compose environment from a Jest `globalSetup` module to
 * its `globalTeardown` counterpart. The two run in the same orchestrator
 * process but as separate module instances, so a non-serialisable handle like
 * this can only travel between them via `globalThis`.
 */

/** Well-known key under which the running environment is stashed. */
const HANDLE_KEY = '__lcpComposeEnv__';

/** Records the running environment for teardown to find. */
export function rememberComposeEnv(
  environment: StartedDockerComposeEnvironment,
): void {
  (globalThis as Record<string, unknown>)[HANDLE_KEY] = environment;
}

/** Retrieves the environment recorded by setup, or undefined if none. */
export function recallComposeEnv():
  | StartedDockerComposeEnvironment
  | undefined {
  return (globalThis as Record<string, unknown>)[HANDLE_KEY] as
    | StartedDockerComposeEnvironment
    | undefined;
}
