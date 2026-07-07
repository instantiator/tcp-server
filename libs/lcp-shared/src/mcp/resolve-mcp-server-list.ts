/** Minimal shape needed to resolve the available MCP server list. */
export interface WithMcpServerList {
  mcpServerList?: string[] | null;
}

/**
 * Resolves the full set of MCP server names available to an agent.
 *
 * Unlike LLM config or system prompt template, this is **additive, not a
 * precedence chain**: every source contributes servers rather than one
 * overriding another. The result is the deduplicated union of the system's
 * default registry servers, the company's extra servers, and the role's
 * extra servers.
 *
 * @param registryNames - Names of the system's default/configured servers
 *   (e.g. `Object.keys(resolveMcpServerUrls(config))`).
 * @param company - The company for the current agent run (may be null).
 * @param role - The role for the current agent run (may be null).
 */
export function resolveMcpServerList(
  registryNames: string[],
  company: WithMcpServerList | null | undefined,
  role: WithMcpServerList | null | undefined,
): string[] {
  return [
    ...new Set([
      ...registryNames,
      ...(company?.mcpServerList ?? []),
      ...(role?.mcpServerList ?? []),
    ]),
  ];
}
