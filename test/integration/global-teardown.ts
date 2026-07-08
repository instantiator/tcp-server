import { recallComposeEnv } from '../support/compose-env-handle';
import { stopComposeTier } from '../support/testcontainers-env';

/**
 * Jest global teardown for the integration tier. Stops and removes the
 * dependency containers (and their volumes) started by global-setup. If the
 * handle is missing (setup failed early), testcontainers' Ryuk reaper still
 * cleans up on process exit.
 */
export default async function globalTeardown(): Promise<void> {
  const environment = recallComposeEnv();
  if (environment) {
    await stopComposeTier(environment);
  }
}
