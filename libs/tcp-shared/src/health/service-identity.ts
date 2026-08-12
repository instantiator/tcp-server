/**
 * Every TCP service answers `GET /health` on its own port, and the ports are
 * configurable. That combination has already produced one silent failure: the
 * smoke tier health-checked tcp-server while reporting it as tcp-agent, because
 * the testing environment publishes tcp-server on the port tcp-agent's check
 * assumed. A health document that names its own service makes that
 * indistinguishable-looking success impossible to mistake for the real one.
 */

/** The service names carried by `/health`. One per deployable HTTP service. */
export type ServiceName =
  | 'tcp-server'
  | 'tcp-agent'
  | 'tcp-mcp-storage'
  | 'tcp-mcp-memory'
  | 'tcp-mcp-interactions'
  | 'tcp-mcp-tasks';

/**
 * The `service` entry a health document carries under `info` and `details`.
 *
 * A `type`, not an `interface`: Terminus's `HealthIndicatorResult` is an
 * index-signature record, and TypeScript infers an implicit index signature
 * for type aliases only — an interface here is rejected as not assignable.
 */
export type ServiceIdentityResult = {
  service: { status: 'up'; name: ServiceName };
};

/**
 * A Terminus health indicator reporting which service answered.
 *
 * Modelled as an indicator rather than a field on the response envelope
 * because Terminus throws its result as a `ServiceUnavailableException` when
 * any check fails — anything added around `check()` is lost from the 503 body,
 * which is exactly the response a reader most needs to identify.
 */
export function serviceIdentity(name: ServiceName): ServiceIdentityResult {
  return { service: { status: 'up', name } };
}

/** A Terminus-shaped health document, as `HealthCheckService.check` returns. */
export interface HealthDocument {
  status: string;
  info: Record<string, { status: string; name?: ServiceName }>;
  error: Record<string, unknown>;
  details: Record<string, { status: string; name?: ServiceName }>;
}

/**
 * The whole health document for a service with no dependency to probe: `ok`,
 * carrying only its identity. Shaped like Terminus's own output so every
 * service's `/health` reads the same way, whether or not it runs checks.
 */
export function staticHealthDocument(name: ServiceName): HealthDocument {
  const identity = serviceIdentity(name);
  return { status: 'ok', info: identity, error: {}, details: identity };
}

/** How often a browser sitting on `/health` re-fetches it, in seconds. */
export const HEALTH_REFRESH_SECONDS = 60;

/**
 * Asks a browser displaying this response to re-fetch it periodically, via the
 * `Refresh` header — non-standard, but honoured by every major browser, and
 * the only way to do this for a response that is JSON rather than HTML (there
 * is no document to put a `<meta http-equiv="refresh">` in).
 *
 * Set on the response object rather than declared with `@Header()` so it
 * survives the failure path too: Terminus throws its document as a
 * `ServiceUnavailableException`, and the exception filter writes status and
 * body onto this same response — headers already set on it are kept, whereas
 * `@Header()` metadata is not applied.
 *
 * Non-browser clients ignore it, so nothing else is affected.
 */
export function setHealthRefresh(res: {
  setHeader(name: string, value: string): void;
}): void {
  res.setHeader('Refresh', String(HEALTH_REFRESH_SECONDS));
}
