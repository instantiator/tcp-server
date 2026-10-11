import {
  ContextBudgetService,
  McpClientService,
  McpServerUnavailableError,
  filterToolsForMode,
  resolveMcpServerList,
  resolveMcpServerUrls,
  serverNamesForMode,
  type TcpAssignmentMode,
  type TcpCompany,
  type TcpRole,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** One MCP server's share of a {@link ToolFootprint}. */
export interface ServerFootprint {
  name: string;
  tools: number;
  tokens: number;
  error?: string;
}

/** What a role's MCP tool schemas cost per turn, in one mode. */
export interface ToolFootprint {
  mode: TcpAssignmentMode;
  servers: ServerFootprint[];
  total: number;
}

/**
 * Stands in for the running agent's id: identity parameters are hidden from
 * the model only when the agent side injects them, so the count needs a value
 * to inject, though no call is ever made.
 */
const PLACEHOLDER_AGENT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Counts the tokens a role's MCP tool schemas cost on every turn — the part
 * of the prompt `estimate-context-window` can't see, because the CLI can't
 * reach the MCP servers and tcp-server can.
 *
 * Servers are chosen exactly as tcp-agent chooses them (the toggle-aware
 * {@link resolveMcpServerList}, then the mode's allowlist), and tools are
 * dropped exactly as tcp-agent drops them ({@link filterToolsForMode}).
 * ponytail: `memory` is counted even for a role with no knowledge, where
 * tcp-agent leaves it out — a worst case; ask RagModule if that matters.
 */
@Injectable()
export class ToolFootprintService {
  constructor(
    private readonly config: ConfigService,
    private readonly mcp: McpClientService,
    private readonly budget: ContextBudgetService,
  ) {}

  /** Loads each server's tools for the role and mode, and counts their schemas. */
  async footprint(
    company: TcpCompany,
    role: TcpRole,
    mode: TcpAssignmentMode,
  ): Promise<ToolFootprint> {
    const urls = resolveMcpServerUrls(this.config);
    const names = serverNamesForMode(
      resolveMcpServerList(Object.keys(urls), company, role),
      mode,
    );
    const context = { agentId: PLACEHOLDER_AGENT_ID, companyId: company.id };
    const servers = await Promise.all(
      names.map(async (name): Promise<ServerFootprint> => {
        try {
          const loaded = await this.mcp.loadTools([name], urls, context, {
            required: true,
          });
          const offered = filterToolsForMode(loaded, mode).map((t) => t.tool);
          return {
            name,
            tools: offered.length,
            tokens: await this.budget.countTools(offered),
          };
        } catch (e) {
          if (!(e instanceof McpServerUnavailableError)) throw e;
          return { name, tools: 0, tokens: 0, error: e.message };
        }
      }),
    );
    return {
      mode,
      servers,
      total: servers.reduce((sum, s) => sum + s.tokens, 0),
    };
  }
}
