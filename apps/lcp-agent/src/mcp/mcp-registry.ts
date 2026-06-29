import { ConfigService } from '@nestjs/config';

/**
 * Canonical registry of MCP services known to lcp-agent.
 *
 * Each entry maps the service's short name to the environment variable that
 * carries its base URL. The agent loop uses this registry to discover which
 * MCP servers are configured at runtime — add a new entry here to make a new
 * MCP service available to the agent.
 */
export const MCP_REGISTRY = [
  { name: 'storage', envKey: 'MCP_STORAGE_URL' },
  { name: 'memory', envKey: 'MCP_MEMORY_URL' },
  { name: 'interactions', envKey: 'MCP_INTERACTIONS_URL' },
] as const;

/**
 * Reads each registered MCP server's URL from environment variables.
 * Returns only the servers whose URL env var is set — omitted entries are
 * silently skipped, so partial deployments work without configuration changes.
 */
export function resolveMcpServerUrls(
  config: ConfigService,
): Record<string, string> {
  const urls: Record<string, string> = {};
  for (const { name, envKey } of MCP_REGISTRY) {
    const url = config.get<string>(envKey);
    if (url) urls[name] = url;
  }
  return urls;
}
