import type { ServiceName } from '@tcp/shared';
import * as http from 'http';

// Requires all services to be running (docker compose --profile auth up).
// Run via: ./scripts/run-smoke-tests.sh
// For remote deployments: ./scripts/run-smoke-tests.sh --base-url http://your-host:3000

const TCP_SERVER = process.env.TCP_SERVER_URL ?? 'http://localhost:3000';
/**
 * tcp-agent is internal-only unless the deployment was started `--dev-ports`,
 * and its host port is deliberately **not** 3001 — that is tcp-server's port
 * under `.env.testing`, so a 3001 default here interrogates tcp-server and
 * reports it as tcp-agent.
 */
const TCP_AGENT = process.env.TCP_AGENT_URL ?? 'http://localhost:3003';
const TCP_MCP_STORAGE =
  process.env.TCP_MCP_STORAGE_URL ?? 'http://localhost:3010';
const TCP_MCP_MEMORY =
  process.env.TCP_MCP_MEMORY_URL ?? 'http://localhost:3011';
const TCP_MCP_INTERACTIONS =
  process.env.TCP_MCP_INTERACTIONS_URL ?? 'http://localhost:3012';
const TCP_MCP_TASKS = process.env.TCP_MCP_TASKS_URL ?? 'http://localhost:3013';
/**
 * Full OIDC discovery URL. Defaults to Zitadel on localhost.
 * Override with OIDC_DISCOVERY_URL for remote deployments.
 */
const OIDC_DISCOVERY =
  process.env.OIDC_DISCOVERY_URL ??
  'http://localhost:8080/.well-known/openid-configuration';

/**
 * A connection failure as Node actually delivers it: `code`, the address that
 * was tried, and — when the happy-eyeballs dialer tried several — the per
 * address failures it aggregated. `@types/node` types none of the latter on
 * `ErrnoException`, and they are the only part worth printing.
 */
type ProbeError = NodeJS.ErrnoException & {
  address?: string;
  port?: number;
  errors?: ProbeError[];
};

/** What a probe found: a response, or the reason there wasn't one. */
type Probe =
  | {
      reached: true;
      status: number;
      body: string;
      headers: http.IncomingHttpHeaders;
    }
  | { reached: false; error: ProbeError };

/**
 * Probes `url`, resolving either way. A connection failure is a result to
 * report, not an exception to propagate: Node's happy-eyeballs dialer throws
 * an `AggregateError` whose own message is empty, which is how "nothing is
 * listening" used to reach the reader as a bare `AggregateError:` and no
 * further detail.
 */
function probe(url: string): Promise<Probe> {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            reached: true,
            status: res.statusCode ?? 0,
            body,
            headers: res.headers,
          }),
        );
      })
      .on('error', (error: ProbeError) => resolve({ reached: false, error }));
  });
}

/** The `code` of an error, or of the first error an AggregateError wraps. */
function errorCode(error: ProbeError): string | undefined {
  return error.code ?? error.errors?.find((inner) => inner.code)?.code;
}

/** Plain-English account of why a probe produced no response. */
function explainUnreachable(url: string, error: ProbeError): string {
  const code = errorCode(error);
  const detail =
    code === 'ECONNREFUSED'
      ? [
          `Nothing is listening on ${url}.`,
          'The container may not be running, or its port may not be published to the host —',
          'tcp-agent and the MCP servers are internal-only unless the deployment was started',
          'with --dev-ports. Check `docker ps` for the service and its published ports.',
        ].join(' ')
      : code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? `The host in ${url} could not be resolved (${code}).`
        : code === 'ECONNRESET'
          ? `The connection to ${url} was reset — the service accepted the socket then dropped it, which usually means it is still starting up.`
          : code === 'ETIMEDOUT'
            ? `The connection to ${url} timed out — the address is routable but nothing answered.`
            : `${url} could not be reached (${code ?? 'no error code'}).`;
  // AggregateError's own message is empty; its children carry the addresses.
  const attempts =
    error.errors
      ?.map(
        (e) =>
          `  - ${e.address ?? '?'}:${e.port ?? '?'} → ${e.code ?? e.message}`,
      )
      .join('\n') ?? `  - ${error.message}`;
  return `${detail}\nAttempted:\n${attempts}`;
}

/**
 * Header carrying soft data-quality warnings — a JSON array of
 * percent-encoded strings (see tcp-server's `validation-warnings.ts`). A
 * warning never fails a request, so it would otherwise pass unseen.
 */
const WARNINGS_HEADER = 'x-tcp-warnings';

/**
 * Decodes {@link WARNINGS_HEADER} into readable lines, or returns `null` when
 * the response carried none. A single undecodable entry falls back to its raw
 * form rather than dropping the batch, matching the CLI's `reportWarnings`.
 */
function formatWarnings(headers: http.IncomingHttpHeaders): string | null {
  const raw = headers[WARNINGS_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  let warnings: string[];
  try {
    warnings = JSON.parse(value) as string[];
  } catch {
    return `Warnings (${WARNINGS_HEADER}, unparseable): ${value}`;
  }
  if (warnings.length === 0) return null;
  return [
    `Warnings (${WARNINGS_HEADER}):`,
    ...warnings.map((w) => {
      try {
        return `  - ${decodeURIComponent(w)}`;
      } catch {
        return `  - ${w}`;
      }
    }),
  ].join('\n');
}

/**
 * Reports any warnings a successful response carried. Printed rather than
 * asserted: a warning is the server flagging something worth a human's
 * attention, not a failure — and an unread one is the same as no warning.
 */
function reportWarnings(url: string, headers: http.IncomingHttpHeaders): void {
  const warnings = formatWarnings(headers);
  if (warnings) console.warn(`${url}\n${warnings}`);
}

/** Pretty-prints a body as JSON when it is JSON, and verbatim when it isn't. */
function formatBody(body: string): string {
  if (body === '') return '(empty response body)';
  try {
    return JSON.stringify(JSON.parse(body) as unknown, null, 2);
  } catch {
    return body.length > 2000 ? `${body.slice(0, 2000)}… (truncated)` : body;
  }
}

/**
 * A terminus health document: per-indicator `up`/`down` with details. Every
 * TCP service also carries a `service` indicator naming itself — see
 * `serviceIdentity` in `libs/tcp-shared/src/health/`.
 */
interface HealthDocument {
  status?: string;
  info?: Record<string, { status?: string; name?: string }>;
  error?: Record<string, { status?: string; message?: string }>;
  details?: Record<
    string,
    { status?: string; message?: string; name?: string }
  >;
}

/** Names the indicators that reported anything other than `up`. */
function explainUnhealthy(parsed: HealthDocument): string {
  const details = parsed.details ?? parsed.error ?? {};
  const down = Object.entries(details).filter(
    ([, value]) => value?.status !== 'up',
  );
  if (down.length === 0) {
    return `Overall status is "${parsed.status ?? '(absent)'}" but no individual indicator reported a failure.`;
  }
  return [
    `${down.length} health indicator${down.length === 1 ? '' : 's'} not "up":`,
    ...down.map(
      ([name, value]) =>
        `  - ${name}: ${value?.status ?? 'unknown'}${value?.message ? ` — ${value.message}` : ''}`,
    ),
  ].join('\n');
}

/**
 * Asserts `url` serves a terminus health document that reports
 * `status: "ok"` **and** identifies itself as `service` — explaining the
 * failure in full when it does not: the response body, pretty-printed, and
 * what the reader should conclude from it.
 */
async function expectHealthy(url: string, service: ServiceName): Promise<void> {
  const result = await probe(url);
  if (!result.reached) {
    throw new Error(
      `Health check failed: ${url}\n\n${explainUnreachable(url, result.error)}`,
    );
  }
  if (result.status !== 200) {
    // 503 is terminus's own "some indicator is down" — its body still names
    // which, so it is worth printing rather than reporting the code alone.
    throw new Error(
      [
        `Health check failed: ${url}`,
        '',
        `The service answered with HTTP ${result.status}, not 200.`,
        result.status === 503
          ? 'A 503 from the health endpoint means the service is running but one of its dependencies is not.'
          : result.status === 404
            ? 'A 404 means something is listening on that port, but it is not this service — check the port is not claimed by another container.'
            : result.status === 401 || result.status === 403
              ? 'The health endpoint is unauthenticated by design, so a 401/403 means the request reached something else entirely.'
              : null,
        '',
        'Response body:',
        formatBody(result.body),
        formatWarnings(result.headers),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }

  let parsed: HealthDocument;
  try {
    parsed = JSON.parse(result.body) as HealthDocument;
  } catch {
    throw new Error(
      [
        `Health check failed: ${url}`,
        '',
        'The response was HTTP 200 but not JSON, so it did not come from a terminus health endpoint.',
        '',
        'Response body:',
        formatBody(result.body),
        formatWarnings(result.headers),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }

  if (parsed.status !== 'ok') {
    throw new Error(
      [
        `Health check failed: ${url}`,
        '',
        explainUnhealthy(parsed),
        '',
        'Response body:',
        formatBody(result.body),
        formatWarnings(result.headers),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }

  // Which service answered, not just that something did. Ports are
  // configurable and services are many: without this, a check pointed at the
  // wrong port passes by interrogating a healthy neighbour.
  const answered = parsed.details?.service?.name ?? parsed.info?.service?.name;
  if (answered !== service) {
    throw new Error(
      [
        `Health check failed: ${url}`,
        '',
        answered === undefined
          ? `Expected ${service}, but the response names no service at all. Either it did not come from a TCP service, or that service predates the identity indicator.`
          : `Expected ${service}, but ${answered} answered on this address — the port is published by, or forwarded to, the wrong service.`,
        '',
        'Response body:',
        formatBody(result.body),
        formatWarnings(result.headers),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }

  reportWarnings(url, result.headers);
}

/** Asserts `url` answers 200, explaining any other outcome. */
async function expectOk(url: string): Promise<void> {
  const result = await probe(url);
  if (!result.reached) {
    throw new Error(
      `Request failed: ${url}\n\n${explainUnreachable(url, result.error)}`,
    );
  }
  if (result.status !== 200) {
    throw new Error(
      [
        `Request failed: ${url}`,
        '',
        `Expected HTTP 200, got ${result.status}.`,
        '',
        'Response body:',
        formatBody(result.body),
        formatWarnings(result.headers),
      ]
        .filter((line): line is string => line !== null)
        .join('\n'),
    );
  }
  reportWarnings(url, result.headers);
}

/** Each TCP service, and where this run expects to reach it. */
const SERVICES: { name: ServiceName; baseUrl: string }[] = [
  { name: 'tcp-server', baseUrl: TCP_SERVER },
  { name: 'tcp-agent', baseUrl: TCP_AGENT },
  { name: 'tcp-mcp-storage', baseUrl: TCP_MCP_STORAGE },
  { name: 'tcp-mcp-memory', baseUrl: TCP_MCP_MEMORY },
  { name: 'tcp-mcp-interactions', baseUrl: TCP_MCP_INTERACTIONS },
  { name: 'tcp-mcp-tasks', baseUrl: TCP_MCP_TASKS },
];

describe('Smoke', () => {
  describe('oidc provider', () => {
    // The URL is in the test name throughout: these addresses come from the
    // environment, and a passing run should show which ones it actually used.
    it(`GET ${OIDC_DISCOVERY} returns 200`, () => expectOk(OIDC_DISCOVERY));
  });

  describe.each(SERVICES.map((s) => [s.name, s.baseUrl] as const))(
    '%s (%s)',
    (name, baseUrl) => {
      it(`GET ${baseUrl}/health returns 200, identifying as ${name}, status ok`, () =>
        expectHealthy(`${baseUrl}/health`, name));

      it(`GET ${baseUrl}/swagger returns 200`, () =>
        expectOk(`${baseUrl}/swagger`));
    },
  );
});
