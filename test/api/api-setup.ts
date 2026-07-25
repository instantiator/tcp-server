import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFileWithLocal } from '../support/env-file-parser';

/**
 * Per-worker setup for the API test tier. Loads env vars from the appropriate
 * env file into `process.env` so tests (and helpers like ApiHelper) can read
 * them. Runs in each Jest worker, unlike `globalSetup` which runs once in a
 * child process whose `process.env` changes don't propagate.
 *
 * Precedence:
 * 1. `.env.run` — written by `run-api-tests.sh` with CLI-resolved values.
 * 2. `.env.dev` — developer's local env (if present).
 * 3. `.env.testing` — static test credentials.
 *
 * The chosen file is layered with its gitignored `<file>.local` override
 * (generated secrets like `TEST_CLIENT_ID/SECRET`). Values already in
 * `process.env` are never overwritten by any of these files.
 */
const REPO_ROOT = resolve(__dirname, '../..');

const envRun = resolve(REPO_ROOT, '.env.run');
const devEnv = resolve(REPO_ROOT, '.env.dev');
const testingEnv = resolve(REPO_ROOT, '.env.testing');

const envFile = existsSync(envRun)
  ? envRun
  : existsSync(devEnv)
    ? devEnv
    : testingEnv;

// Layers the chosen file with its gitignored `<file>.local` override, which is
// where start-deployment.sh writes the generated TEST_CLIENT_ID/SECRET. (When
// run-api-tests.sh drove this via `.env.run`, those values are already resolved
// into it and there is no `.env.run.local`, so the override is a no-op there.)
loadEnvFileWithLocal(envFile);
