import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describeProbeError } from './utils/model-validator';

const REPO_ROOT = join(__dirname, '..', '..');

/** Which env file and Compose project to check. */
export interface TestConfigOptions {
  envFile: string;
  project: string;
}

type Outcome = 'pass' | 'fail' | 'skip';

/** One line of the report. */
interface Check {
  name: string;
  outcome: Outcome;
  /** What's wrong, and what to try — empty for a pass. */
  detail?: string;
}

/** A variable set, in precedence order: the `.local` override wins. */
type Env = Map<string, string>;

/**
 * Checks every connection an instance depends on and prints one line each:
 * the env file, Docker, tcp-server's own dependency checks (database, Redis,
 * MinIO, OIDC), the OIDC issuer as the host sees it, the internal services,
 * the web client, and the LLM and embedding endpoints.
 *
 * The LLM and embedding probes run inside tcp-agent, with its environment,
 * because that is the address the agents actually use — `localhost` on the
 * host and in a container are different machines.
 *
 * Returns the exit code: 0 when nothing failed.
 */
export async function testConfig(opts: TestConfigOptions): Promise<number> {
  const envPath = resolve(REPO_ROOT, opts.envFile);
  console.log(`Testing ${opts.envFile} (project: ${opts.project})\n`);

  const checks: Check[] = [];
  const report = (check: Check): void => {
    checks.push(check);
    printCheck(check);
  };

  if (!existsSync(envPath)) {
    report({
      name: 'Env file',
      outcome: 'fail',
      detail: `${envPath} doesn't exist. Run the wizard to create it, or pass --env <file>.`,
    });
    return 1;
  }
  const env = loadEnv(envPath);
  report(checkRequiredVars(env, opts.envFile));

  const docker = run('docker', ['info']);
  if (docker.status !== 0) {
    report({
      name: 'Docker',
      outcome: 'fail',
      detail:
        'Docker is not running. Start Docker Desktop (or the daemon) and re-run.',
    });
    return 1;
  }
  const running = compose(opts, ['ps', '--status', 'running', '-q']);
  const stackUp = running.status === 0 && running.stdout.trim().length > 0;
  const startHint = `start it with: ./scripts/start-dev.sh --env ${opts.envFile} --project ${opts.project}`;
  report(
    stackUp
      ? { name: 'Stack running', outcome: 'pass' }
      : {
          name: 'Stack running',
          outcome: 'fail',
          detail: `No running containers for project ${opts.project} — ${startHint}`,
        },
  );

  const apiPort = env.get('EXPOSE_PORT_API') || '3000';
  const issuer =
    env.get('OIDC_ISSUER_URL') ||
    `http://localhost:${env.get('EXPOSE_PORT_ZITADEL') || '8080'}`;

  if (stackUp) {
    for (const check of await checkServerHealth(apiPort)) report(check);
  }
  report(await checkOidcFromHost(issuer, stackUp));

  const internal: ReadonlyArray<[string, number]> = [
    ['tcp-agent', 3001],
    ['tcp-mcp-storage', 3010],
    ['tcp-mcp-memory', 3011],
    ['tcp-mcp-interactions', 3012],
    ['tcp-mcp-tasks', 3013],
  ];
  for (const [service, port] of internal) {
    report(
      stackUp
        ? checkInternalHealth(opts, service, port)
        : {
            name: service,
            outcome: 'skip',
            detail: `stack not running — ${startHint}`,
          },
    );
  }

  const webUrl = `https://localhost:${env.get('EXPOSE_PORT_WEB') || '5173'}`;
  report(
    stackUp
      ? checkWeb(webUrl)
      : {
          name: 'Web client',
          outcome: 'skip',
          detail: `stack not running — ${startHint}`,
        },
  );

  for (const purpose of ['chat', 'embedding'] as const) {
    report(checkModel(opts, env, purpose, stackUp, startHint));
  }

  const failed = checks.filter((c) => c.outcome === 'fail').length;
  const skipped = checks.filter((c) => c.outcome === 'skip').length;
  console.log(
    `\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}${skipped ? `, ${skipped} skipped` : ''}.`,
  );
  return failed === 0 && stackUp ? 0 : 1;
}

/** Prints one check as `✓ name`, `✗ name — detail` or `- name — detail`. */
function printCheck(check: Check): void {
  const mark = { pass: '✓', fail: '✗', skip: '-' }[check.outcome];
  console.log(
    `  ${mark} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
  );
}

/**
 * Reads `KEY=value` lines from the env file and its `.local` override, the
 * same precedence start-deployment.sh uses: the override wins.
 */
function loadEnv(envPath: string): Env {
  const env: Env = new Map();
  for (const path of [envPath, `${envPath}.local`]) {
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
      const line = raw.trim();
      const eq = line.indexOf('=');
      if (line.startsWith('#') || eq === -1) continue;
      env.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
  }
  return env;
}

/** The variables start-deployment.sh refuses to start without. */
function checkRequiredVars(env: Env, envFile: string): Check {
  const required = [
    'DB_PASSWORD',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'INTERNAL_API_KEY',
  ];
  // The bundled Zitadel generates the client credentials; an external
  // provider's must be supplied.
  if (!env.get('ZITADEL_ADMIN_PASSWORD')) {
    required.push('OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET');
  }
  const missing = required.filter((key) => !env.get(key));
  return missing.length === 0
    ? { name: 'Env file', outcome: 'pass' }
    : {
        name: 'Env file',
        outcome: 'fail',
        detail: `missing ${missing.join(', ')}. Add them to ${envFile} or ${envFile}.local (see .env.example).`,
      };
}

/** Hints for tcp-server's own dependency checks, by Terminus key. */
const HEALTH_HINTS: Record<string, string> = {
  database: 'check the postgres container: docker compose logs postgres',
  redis: 'check the redis container: docker compose logs redis',
  minio: 'check the minio container and MINIO_* settings',
  oidc: "tcp-server can't reach the OIDC provider. For the bundled Zitadel, re-run start-dev.sh; for an external one, check OIDC_ISSUER_URL",
};

/** tcp-server's /health reports on each of its dependencies; one line each. */
async function checkServerHealth(apiPort: string): Promise<Check[]> {
  const url = `http://localhost:${apiPort}/health`;
  let body: unknown;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    body = await res.json();
  } catch (err) {
    return [
      {
        name: 'tcp-server',
        outcome: 'fail',
        detail: `no answer at ${url} (${errorText(err)}). Check: docker compose logs tcp-server`,
      },
    ];
  }
  const details =
    isRecord(body) && isRecord(body['details']) ? body['details'] : {};
  const checks: Check[] = [];
  for (const [key, value] of Object.entries(details)) {
    if (key === 'service') continue; // the service's own name, not a dependency
    const up = isRecord(value) && value['status'] === 'up';
    const message =
      isRecord(value) && typeof value['message'] === 'string'
        ? value['message']
        : '';
    checks.push(
      up
        ? { name: `tcp-server → ${key}`, outcome: 'pass' }
        : {
            name: `tcp-server → ${key}`,
            outcome: 'fail',
            detail: `${message ? `${message}. ` : ''}${HEALTH_HINTS[key] ?? ''}`,
          },
    );
  }
  return checks.length > 0
    ? checks
    : [
        {
          name: 'tcp-server',
          outcome: 'fail',
          detail: `unexpected /health reply from ${url}`,
        },
      ];
}

/** Browsers and tcp-cli sign in against the issuer as the host sees it. */
async function checkOidcFromHost(
  issuer: string,
  stackUp: boolean,
): Promise<Check> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body: unknown = await res.json();
    if (res.ok && isRecord(body) && typeof body['issuer'] === 'string') {
      return { name: 'OIDC issuer (from this machine)', outcome: 'pass' };
    }
    return {
      name: 'OIDC issuer (from this machine)',
      outcome: 'fail',
      detail: `${url} answered HTTP ${res.status} without a discovery document. Check OIDC_ISSUER_URL.`,
    };
  } catch (err) {
    return {
      name: 'OIDC issuer (from this machine)',
      outcome: stackUp ? 'fail' : 'skip',
      detail: `no answer at ${url} (${errorText(err)}).${stackUp ? ' For the bundled Zitadel: docker compose logs zitadel' : ''}`,
    };
  }
}

/** Internal services have no host port by default; ask from inside. */
function checkInternalHealth(
  opts: TestConfigOptions,
  service: string,
  port: number,
): Check {
  const result = compose(opts, [
    'exec',
    '-T',
    service,
    'curl',
    '-sf',
    `http://localhost:${port}/health`,
  ]);
  return result.status === 0
    ? { name: service, outcome: 'pass' }
    : {
        name: service,
        outcome: 'fail',
        detail: `not healthy. Check: docker compose -p ${opts.project} logs ${service}`,
      };
}

/** The web client is served over TLS with a self-signed certificate by default. */
function checkWeb(webUrl: string): Check {
  const result = run('curl', [
    '-skf',
    '-o',
    '/dev/null',
    `${webUrl}/config.js`,
  ]);
  return result.status === 0
    ? { name: 'Web client', outcome: 'pass' }
    : {
        name: 'Web client',
        outcome: 'fail',
        detail: `no answer at ${webUrl}. Check: docker compose logs tcp-web`,
      };
}

/**
 * Runs inside tcp-agent: sends one tiny chat or embedding request using the
 * container's own `LLM_*` / `EMBEDDING_*` variables, and prints the outcome as
 * JSON. Kept dependency-free, because it runs with `node -e`.
 */
const IN_CONTAINER_PROBE = `
const prefix = process.argv[1] === 'chat' ? 'LLM' : 'EMBEDDING';
const provider = process.env[prefix + '_PROVIDER'];
const model = process.env[prefix + '_MODEL'];
if (!provider || !model) { console.log(JSON.stringify({ configured: false })); process.exit(0); }
const base = (process.env[prefix + '_BASE_URL'] || 'https://api.openai.com/v1').replace(/\\/+$/, '');
const url = base + (prefix === 'LLM' ? '/chat/completions' : '/embeddings');
const body = prefix === 'LLM'
  ? { model, messages: [{ role: 'user', content: 'Say "ok"' }], max_tokens: 5 }
  : { model, input: 'test' };
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env[prefix + '_API_KEY'] || provider) },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000),
}).then(async (res) => {
  const text = await res.text();
  console.log(JSON.stringify({ configured: true, provider, model, url, status: res.status, body: text.slice(0, 2000) }));
}).catch((err) => {
  const code = err && err.cause && err.cause.code;
  console.log(JSON.stringify({ configured: true, provider, model, url, errorName: err && err.name, errorCode: code, errorMessage: String(err && err.message) }));
});
`;

/** The probe's printed outcome. */
interface ProbeOutput {
  configured: boolean;
  provider?: string;
  model?: string;
  url?: string;
  status?: number;
  body?: string;
  errorName?: string;
  errorCode?: string;
  errorMessage?: string;
}

/** Sends a real request to the chat or embedding model, from inside tcp-agent. */
function checkModel(
  opts: TestConfigOptions,
  env: Env,
  purpose: 'chat' | 'embedding',
  stackUp: boolean,
  startHint: string,
): Check {
  const name = purpose === 'chat' ? 'Chat model' : 'Embedding model';
  const prefix = purpose === 'chat' ? 'LLM' : 'EMBEDDING';
  if (!env.get(`${prefix}_PROVIDER`)) {
    return {
      name,
      outcome: 'skip',
      detail:
        purpose === 'chat'
          ? 'not configured at application level (companies and roles can still set one)'
          : "not configured — knowledge documents can't be uploaded without one",
    };
  }
  if (!stackUp) {
    return {
      name,
      outcome: 'skip',
      detail: `tested from inside tcp-agent — ${startHint}`,
    };
  }

  const result = compose(opts, [
    'exec',
    '-T',
    'tcp-agent',
    'node',
    '-e',
    IN_CONTAINER_PROBE,
    purpose,
  ]);
  const output = parseProbeOutput(result.stdout);
  if (!output) {
    return {
      name,
      outcome: 'fail',
      detail: `couldn't run the probe in tcp-agent (${result.stderr.trim().split('\n')[0] || 'no output'})`,
    };
  }
  if (!output.configured) {
    return {
      name,
      outcome: 'fail',
      detail: `${prefix}_PROVIDER is set in the env file but not in the tcp-agent container. Restart the stack so it picks up the change.`,
    };
  }
  if (
    output.status !== undefined &&
    output.status >= 200 &&
    output.status < 300
  ) {
    return {
      name: `${name} (${output.provider}/${output.model})`,
      outcome: 'pass',
    };
  }

  const error = output.errorName
    ? Object.assign(new Error(output.errorMessage ?? ''), {
        name: output.errorName,
        cause: { code: output.errorCode },
      })
    : undefined;
  const url = output.url ?? '';
  const localHint = /\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)
    ? ' Inside Docker, localhost is the container itself — use host.docker.internal for a server on this machine.'
    : '';
  return {
    name: `${name} (${output.provider}/${output.model})`,
    outcome: 'fail',
    detail:
      describeProbeError({
        url,
        providerName: output.provider ?? '',
        model: output.model ?? '',
        status: output.status,
        body: output.body,
        error,
      }) + localHint,
  };
}

/** The last line of the probe's stdout, if it is the JSON it prints. */
function parseProbeOutput(stdout: string): ProbeOutput | undefined {
  const last = stdout.trim().split('\n').pop() ?? '';
  try {
    const parsed: unknown = JSON.parse(last);
    if (!isRecord(parsed) || typeof parsed['configured'] !== 'boolean') {
      return undefined;
    }
    const str = (key: string): string | undefined =>
      typeof parsed[key] === 'string' ? parsed[key] : undefined;
    return {
      configured: parsed['configured'],
      provider: str('provider'),
      model: str('model'),
      url: str('url'),
      status:
        typeof parsed['status'] === 'number' ? parsed['status'] : undefined,
      body: str('body'),
      errorName: str('errorName'),
      errorCode: str('errorCode'),
      errorMessage: str('errorMessage'),
    };
  } catch {
    return undefined;
  }
}

/** Runs `docker compose` against this project, from the repo root. */
function compose(opts: TestConfigOptions, args: string[]) {
  return run('docker', [
    'compose',
    '-p',
    opts.project,
    '-f',
    join(REPO_ROOT, 'docker-compose.yml'),
    ...args,
  ]);
}

/** Runs a command, capturing its output; never throws. */
function run(
  cmd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 60_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause: unknown = err.cause;
    if (isRecord(cause) && typeof cause['code'] === 'string')
      return cause['code'];
    return err.message;
  }
  return String(err);
}
