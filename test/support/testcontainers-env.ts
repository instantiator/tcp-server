import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DockerComposeEnvironment,
  StartedDockerComposeEnvironment,
} from 'testcontainers';
import { loadEnvFileWithLocal } from './env-file-parser';

/**
 * Starts the dependency containers an integration/e2e test run needs, driving
 * the project's existing {@link https://docs.docker.com/compose/ docker-compose.yml}
 * through testcontainers rather than a shell script. Ports are randomised (via
 * the dynamic-ports overlay) so runs never collide, and connection details are
 * read back from the running containers and exposed as env vars.
 */

/** Absolute path to the repository root, resolved from this file's location. */
const REPO_ROOT = resolve(__dirname, '../..');

/**
 * Compose files applied in order: the real deployment file, then the test-only
 * overlay that swaps fixed host ports for random ones.
 */
const COMPOSE_FILES = [
  'docker-compose.yml',
  'test/support/docker-compose.dynamic-ports.yml',
];

/** Env file carrying the static test credentials the containers and apps read. */
const ENV_FILE = '.env.testing';

/** Container-internal ports, keyed by the service they belong to. */
const SERVICE_PORTS = {
  postgres: 5432,
  redis: 6379,
  minio: 9000,
  'stub-llm': 3002,
} as const;

/** A compose service this helper knows how to start and address. */
type KnownService = keyof typeof SERVICE_PORTS;

/** Configuration for a single tier's dependency stack. */
export interface ComposeTierOptions {
  /**
   * Short tier label ('integration' / 'e2e'). Names the diagnostics directory
   * (`test-results/<tier>-compose-logs/`) and the compose project.
   */
  tier: string;
  /** Compose service names to start, e.g. `['postgres', 'redis', 'minio']`. */
  services: KnownService[];
  /** Compose profiles to enable (e.g. `['integration']` to include stub-llm). */
  profiles?: string[];
  /** Maximum time to wait for the environment to become healthy. */
  startupTimeoutMs?: number;
}

/** The outcome of starting a tier's dependency stack. */
export interface ComposeTierResult {
  /** Handle for the running environment; pass to {@link stopComposeTier}. */
  environment: StartedDockerComposeEnvironment;
  /**
   * Connection env vars derived from the running containers (DATABASE_URL,
   * REDIS_URL, ...). Also assigned onto {@link process.env} as a side effect so
   * spec files and the apps they boot pick them up.
   */
  env: Record<string, string>;
}

/** The compose CLI flags identifying a specific started environment. */
function composeSelector(projectName: string): string[] {
  const fileFlags = COMPOSE_FILES.flatMap((file) => ['-f', file]);
  return ['compose', '-p', projectName, ...fileFlags, '--env-file', ENV_FILE];
}

/**
 * Persists each service's container logs to
 * `test-results/<tier>-compose-logs/<service>.log` so a failed startup can be
 * analysed after the fact (in CI, uploaded as an artifact) rather than
 * scrolling out of a terminal. Best-effort: a service that never started
 * simply yields an empty or error-noting file.
 */
function captureLogs(
  tier: string,
  projectName: string,
  services: string[],
): string {
  const logDir = join(REPO_ROOT, 'test-results', `${tier}-compose-logs`);
  mkdirSync(logDir, { recursive: true });
  for (const service of services) {
    const logFile = join(logDir, `${service}.log`);
    try {
      const output = execFileSync(
        'docker',
        [...composeSelector(projectName), 'logs', '--no-color', service],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
      writeFileSync(logFile, output);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeFileSync(
        logFile,
        `Could not capture logs for ${service}: ${message}\n`,
      );
    }
  }
  return logDir;
}

/**
 * Turns a raw startup failure into an actionable message, distinguishing the
 * two failure modes that otherwise both read as an opaque timeout: a port that
 * could not be bound, and a container that started but exited/crash-looped.
 */
function describeStartupFailure(
  projectName: string,
  cause: unknown,
  logDir: string,
): string {
  const causeMessage = cause instanceof Error ? cause.message : String(cause);

  if (
    /port is already allocated|address already in use|bind for .* failed/i.test(
      causeMessage,
    )
  ) {
    return (
      'Docker could not bind a host port for a dependency container. The ' +
      'dynamic-ports overlay should make this rare — check the overlay is ' +
      "applied and Docker's ephemeral port range isn't exhausted.\n" +
      `Compose logs: ${logDir}\nOriginal error: ${causeMessage}`
    );
  }

  const exited = findExitedServices(projectName);
  if (exited.length > 0) {
    return (
      `A dependency container exited before becoming healthy: ${exited.join(', ')}. ` +
      'This usually means it was misconfigured (bad env var, missing volume) ' +
      'rather than slow to start — check its captured logs.\n' +
      `Compose logs: ${logDir}\nOriginal error: ${causeMessage}`
    );
  }

  return (
    'Dependency containers did not become healthy within the startup timeout. ' +
    'Check the captured logs for the slow/failing service, and confirm Docker ' +
    'has enough resources.\n' +
    `Compose logs: ${logDir}\nOriginal error: ${causeMessage}`
  );
}

/** Compose services that have exited (non-running), per `docker compose ps`. */
function findExitedServices(projectName: string): string[] {
  try {
    const output = execFileSync(
      'docker',
      [
        ...composeSelector(projectName),
        'ps',
        '-a',
        '--format',
        '{{.Service}} {{.State}}',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.endsWith(' running'))
      .map((line) => line.split(' ')[0]);
  } catch {
    return [];
  }
}

/** Builds the connection env vars for the services that were started. */
function deriveConnectionEnv(
  environment: StartedDockerComposeEnvironment,
  services: KnownService[],
): Record<string, string> {
  const env: Record<string, string> = {};
  const mappedUrl = (service: KnownService): { host: string; port: number } => {
    const container = environment.getContainer(`${service}-1`);
    return {
      host: container.getHost(),
      port: container.getMappedPort(SERVICE_PORTS[service]),
    };
  };

  if (services.includes('postgres')) {
    const { host, port } = mappedUrl('postgres');
    // Password comes from .env.testing (loaded by loadTestEnv above), never a
    // hardcoded literal.
    const password = process.env.DB_PASSWORD;
    if (!password) {
      throw new Error('DB_PASSWORD is not set — expected it in .env.testing.');
    }
    const user = process.env.DB_USER ?? 'tcp';
    const dbName = process.env.DB_NAME ?? 'tcp';
    const credentials = `${user}:${password}`;
    env.DATABASE_URL = `postgres://${credentials}@${host}:${port}/${dbName}`;
  }
  if (services.includes('redis')) {
    const { host, port } = mappedUrl('redis');
    env.REDIS_URL = `redis://${host}:${port}`;
  }
  if (services.includes('minio')) {
    const { host, port } = mappedUrl('minio');
    env.MINIO_ENDPOINT = `http://${host}:${port}`;
  }
  if (services.includes('stub-llm')) {
    const { host, port } = mappedUrl('stub-llm');
    env.STUB_LLM_URL = `http://${host}:${port}/v1`;
  }
  return env;
}

/**
 * Starts a tier's dependency containers and returns their connection details.
 * On failure, captures per-service logs to disk and throws an error that names
 * the likely cause. The returned {@link ComposeTierResult.env} is also assigned
 * onto {@link process.env}.
 */
export async function startComposeTier(
  options: ComposeTierOptions,
): Promise<ComposeTierResult> {
  loadEnvFileWithLocal(join(REPO_ROOT, ENV_FILE));

  const projectName = `tcp-${options.tier}-${process.pid}`;
  let composeEnv = new DockerComposeEnvironment(REPO_ROOT, COMPOSE_FILES)
    .withProjectName(projectName)
    .withEnvironmentFile(ENV_FILE)
    .withStartupTimeout(options.startupTimeoutMs ?? 120_000);
  if (options.profiles && options.profiles.length > 0) {
    composeEnv = composeEnv.withProfiles(...options.profiles);
  }

  let environment: StartedDockerComposeEnvironment;
  try {
    environment = await composeEnv.up(options.services);
  } catch (cause) {
    const logDir = captureLogs(options.tier, projectName, options.services);
    // Best-effort cleanup so a failed start does not leak containers.
    try {
      execFileSync('docker', [...composeSelector(projectName), 'down', '-v'], {
        cwd: REPO_ROOT,
        stdio: 'ignore',
      });
    } catch {
      // Ryuk reaps anything left behind on process exit.
    }
    throw new Error(describeStartupFailure(projectName, cause, logDir), {
      cause,
    });
  }

  const env = deriveConnectionEnv(environment, options.services);
  Object.assign(process.env, env);
  return { environment, env };
}

/** Tears down a started tier, removing its containers and volumes. */
export async function stopComposeTier(
  environment: StartedDockerComposeEnvironment,
): Promise<void> {
  await environment.down({ removeVolumes: true });
}
