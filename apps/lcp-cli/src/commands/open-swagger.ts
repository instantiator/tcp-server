import { execSync } from 'child_process';
import { Command } from 'commander';

/** Services that expose a Swagger UI endpoint. */
const SERVICES = [
  'lcp-server',
  'lcp-agent',
  'lcp-mcp-storage',
  'lcp-mcp-memory',
  'lcp-mcp-interactions',
] as const;

type Service = (typeof SERVICES)[number];

/** Default base URLs keyed by service name, matching the smoke-test env-var conventions. */
const DEFAULT_URLS: Record<Service, string> = {
  'lcp-server': process.env['LCP_SERVER_URL'] ?? 'http://localhost:3000',
  'lcp-agent': process.env['LCP_AGENT_URL'] ?? 'http://localhost:3001',
  'lcp-mcp-storage':
    process.env['LCP_MCP_STORAGE_URL'] ?? 'http://localhost:3010',
  'lcp-mcp-memory':
    process.env['LCP_MCP_MEMORY_URL'] ?? 'http://localhost:3011',
  'lcp-mcp-interactions':
    process.env['LCP_MCP_INTERACTIONS_URL'] ?? 'http://localhost:3012',
};

/**
 * Prints the Swagger UI URL for the given service and optionally opens it in
 * the default browser.
 *
 * stdout: the Swagger UI URL.
 */
export function registerOpenSwagger(program: Command): void {
  program
    .command('open-swagger')
    .description(
      'Print (and optionally open) the Swagger UI for an LCP service',
    )
    .requiredOption(
      '--service <name>',
      `Service to open (${SERVICES.join(' | ')})`,
    )
    .option('--no-open', 'Print the URL without opening the browser')
    .action((cmdOpts: { service: string; open: boolean }) => {
      if (!SERVICES.includes(cmdOpts.service as Service)) {
        process.stderr.write(
          `Unknown service "${cmdOpts.service}". Valid options: ${SERVICES.join(', ')}\n`,
        );
        process.exit(1);
      }

      const base = DEFAULT_URLS[cmdOpts.service as Service].replace(/\/$/, '');
      const url = `${base}/swagger`;

      process.stdout.write(url + '\n');

      if (!cmdOpts.open) return;

      const opener =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
            ? 'start'
            : 'xdg-open';
      try {
        execSync(`${opener} "${url}"`, { stdio: 'ignore' });
      } catch {
        // Non-fatal: URL was already printed, user can open manually
      }
    });
}
