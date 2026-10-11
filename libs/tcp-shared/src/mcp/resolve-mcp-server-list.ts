/**
 * MCP servers switched on (`true`) or off (`false`), by registry name. Set on
 * a company and/or a role; a server not mentioned is on.
 */
export type McpServerToggles = Record<string, boolean>;

/** Minimal shape needed to resolve the available MCP server list. */
export interface WithMcpServerList {
  mcpServerList?: string[] | null;
  mcpServerToggles?: McpServerToggles | null;
}

/**
 * Resolves the full set of MCP server names available to an agent.
 *
 * The candidates are **additive**: the deduplicated union of the system's
 * configured servers, the company's extra servers, and the role's extra
 * servers. Each candidate then passes through the toggles, which **are** a
 * precedence chain — the role's toggle, else the company's, else on — so a
 * company can switch a server off for all its roles, and one role can switch
 * it back on (or off) for itself.
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
  const candidates = new Set([
    ...registryNames,
    ...(company?.mcpServerList ?? []),
    ...(role?.mcpServerList ?? []),
  ]);
  return [...candidates].filter(
    (name) =>
      role?.mcpServerToggles?.[name] ??
      company?.mcpServerToggles?.[name] ??
      true,
  );
}
