import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ServerHealthService } from '../health/server-health.service';

/** How long one service's health probe may take before it counts as down. */
const PROBE_TIMEOUT_MS = 5000;

/** One service's line in the combined report. */
export interface ServiceHealth {
  name: string;
  /** `not_configured`: this deployment has no URL for the service, so it was not asked. */
  status: 'up' | 'down' | 'not_configured';
  /** The service's own health document, when it sent one. */
  detail?: unknown;
  /** Why the probe itself failed (no answer, timeout), when it did. */
  error?: string;
}

/** Every service's health in one answer. `degraded` means at least one is down. */
export interface SystemHealth {
  status: 'ok' | 'degraded';
  services: ServiceHealth[];
}

/**
 * The services reached over HTTP, in report order, with the config key that
 * holds each one's URL. Only the URL's origin is used: `/health` sits at the
 * root of every service.
 */
const REMOTE_SERVICES: { name: string; urlKey: string }[] = [
  { name: 'tcp-agent', urlKey: 'TCP_AGENT_URL' },
  { name: 'tcp-mcp-storage', urlKey: 'MCP_STORAGE_URL' },
  { name: 'tcp-mcp-memory', urlKey: 'MCP_MEMORY_URL' },
  { name: 'tcp-mcp-interactions', urlKey: 'MCP_INTERACTIONS_URL' },
  { name: 'tcp-mcp-tasks', urlKey: 'MCP_TASKS_URL' },
];

/**
 * Collects the health of every service into one report, so an admin can see
 * the whole system from the browser or the CLI. tcp-agent and the MCP
 * servers are internal-only, so tcp-server asks them on the internal network.
 *
 * Separate from each service's own `GET /health`, which stays a plain
 * liveness probe for Compose: a service's health never depends on another's.
 */
@Injectable()
export class SystemHealthService {
  constructor(
    private readonly serverHealth: ServerHealthService,
    private readonly config: ConfigService,
  ) {}

  /** Probes every service in parallel; never throws for a down service. */
  async check(): Promise<SystemHealth> {
    const services = await Promise.all([
      this.checkSelf(),
      ...REMOTE_SERVICES.map(({ name, urlKey }) =>
        this.probe(name, this.config.get<string>(urlKey)),
      ),
    ]);
    const degraded = services.some((service) => service.status === 'down');
    return { status: degraded ? 'degraded' : 'ok', services };
  }

  /** tcp-server's own checks, run in process rather than over HTTP to itself. */
  private async checkSelf(): Promise<ServiceHealth> {
    try {
      return {
        name: 'tcp-server',
        status: 'up',
        detail: await this.serverHealth.check(),
      };
    } catch (err) {
      if (err instanceof ServiceUnavailableException) {
        return {
          name: 'tcp-server',
          status: 'down',
          detail: err.getResponse(),
        };
      }
      return { name: 'tcp-server', status: 'down', error: errorText(err) };
    }
  }

  /** Asks one service for its `/health`. Any non-2xx answer counts as down. */
  private async probe(name: string, url?: string): Promise<ServiceHealth> {
    if (!url) return { name, status: 'not_configured' };
    try {
      const res = await fetch(`${new URL(url).origin}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const detail: unknown = await res.json().catch(() => undefined);
      return { name, status: res.ok ? 'up' : 'down', detail };
    } catch (err) {
      return { name, status: 'down', error: errorText(err) };
    }
  }
}

/** A thrown value as readable text. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
