import { printAndMaybeOpen } from './open-url';

/** Services that expose a Swagger UI endpoint. */
export const SWAGGER_SERVICES = [
  'lcp-server',
  'lcp-agent',
  'lcp-mcp-storage',
  'lcp-mcp-memory',
  'lcp-mcp-interactions',
  'lcp-mcp-tasks',
] as const;

export type SwaggerService = (typeof SWAGGER_SERVICES)[number];

/**
 * Browser-accessible base URLs keyed by service name.
 *
 * Uses `LCP_*_BROWSER_URL` env vars rather than `LCP_*_URL`, which are
 * typically set to Docker-internal hostnames (e.g. `http://lcp-server:3000`)
 * and are not reachable from the host browser.
 */
function defaultServiceUrls(): Record<SwaggerService, string> {
  return {
    'lcp-server':
      process.env['LCP_SERVER_BROWSER_URL'] ?? 'http://localhost:3000',
    'lcp-agent':
      process.env['LCP_AGENT_BROWSER_URL'] ?? 'http://localhost:3001',
    'lcp-mcp-storage':
      process.env['LCP_MCP_STORAGE_BROWSER_URL'] ?? 'http://localhost:3010',
    'lcp-mcp-memory':
      process.env['LCP_MCP_MEMORY_BROWSER_URL'] ?? 'http://localhost:3011',
    'lcp-mcp-interactions':
      process.env['LCP_MCP_INTERACTIONS_BROWSER_URL'] ??
      'http://localhost:3012',
    'lcp-mcp-tasks':
      process.env['LCP_MCP_TASKS_BROWSER_URL'] ?? 'http://localhost:3013',
  };
}

/**
 * Prints the Swagger UI URL for the given service and optionally opens it in
 * the default browser.
 *
 * stdout: the Swagger UI URL.
 */
export function openSwaggerAction(cmdOpts: {
  service: string;
  open: boolean;
}): void {
  if (!SWAGGER_SERVICES.includes(cmdOpts.service as SwaggerService)) {
    process.stderr.write(
      `Unknown service "${cmdOpts.service}". Valid options: ${SWAGGER_SERVICES.join(', ')}\n`,
    );
    process.exit(1);
  }

  const rawBase = defaultServiceUrls()[cmdOpts.service as SwaggerService];
  const base = rawBase.replace(/\/$/, '');
  printAndMaybeOpen(`${base}/swagger`, cmdOpts.open);
}
