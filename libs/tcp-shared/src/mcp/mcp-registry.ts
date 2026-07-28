import { ConfigService } from '@nestjs/config';

/**
 * Canonical registry of MCP services known to the TCP platform.
 *
 * Each entry maps the service's short name to the environment variable that
 * carries its base URL, plus a one-line `usage` description of when an agent
 * should reach for it. `usage` is surfaced in the agent's initial prompt (see
 * {@link AgentLoopService.buildServicesMessage}) — individual tool names,
 * parameters, and descriptions are not repeated there since LangChain's
 * `bindTools` already sends full tool schemas to the LLM on every turn; only
 * the higher-level "when would I use this service" framing is missing from
 * that and worth spelling out.
 *
 * Used by both tcp-agent and tcp-server to discover which MCP servers are
 * configured at runtime — add a new entry here to make a new MCP service
 * available everywhere.
 */
export const MCP_REGISTRY = [
  {
    name: 'storage',
    envKey: 'MCP_STORAGE_URL',
    usage:
      'reading, writing, and searching shared files — task materials, work-in-progress output, and finished reports.',
  },
  {
    name: 'memory',
    envKey: 'MCP_MEMORY_URL',
    usage:
      'recalling prior knowledge or episodic memories, and searching the knowledge base for your role.',
  },
  {
    name: 'interactions',
    envKey: 'MCP_INTERACTIONS_URL',
    usage: 'asking a human a question or consulting another agent role.',
  },
  {
    name: 'tasks',
    envKey: 'MCP_TASKS_URL',
    usage:
      'completing your assignment — planning a task, submitting finished work, or assuring another agent’s work (the exact tool depends on your mode).',
  },
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
