import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from '../support/env-file-parser';

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
 * Values already in `process.env` are never overwritten by any of these files.
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

loadEnvFile(envFile);
