import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerDescribeServer } from '@tcp/shared';
import { storagePrompts } from '../storage-prompts';
import { storageToolDescriptions } from '../storage-tool-descriptions';
import { MaterialFileToolsService } from './material-file-tools.service';
import { SharedStorageToolsService } from './shared-storage-tools.service';
import { WorkingFileToolsService } from './working-file-tools.service';

/**
 * Builds fresh {@link McpServer} instances pre-loaded with all storage tools.
 * A new server is created per request so state is never shared across sessions.
 *
 * Three tiers of tool, one collaborator each — the tier a tool belongs to is
 * what decides how far it can reach:
 * - {@link SharedStorageToolsService} — read-only exploration of shared storage
 *   by full object key.
 * - {@link WorkingFileToolsService} — the caller's own working directory,
 *   resolved server-side from its assignment; qa-mode callers are read-only.
 * - {@link MaterialFileToolsService} — read-only access to the assignment's
 *   attached materials, addressed by name.
 *
 * All file-action logic (validation, soft-delete, content analysis, audit)
 * lives on `tcp-server` behind `/internal/storage/*` — these services are a
 * thin HTTP proxy plus the MCP `ToolResult` presentation layer.
 */
@Injectable()
export class StorageToolsService {
  constructor(
    private readonly shared: SharedStorageToolsService,
    private readonly working: WorkingFileToolsService,
    private readonly materials: MaterialFileToolsService,
  ) {}

  /** Creates and returns a configured McpServer with all storage tools registered. */
  createServer(): McpServer {
    const server = new McpServer({ name: 'tcp-mcp-storage', version: '1.0.0' });

    registerDescribeServer(
      server,
      storageToolDescriptions.describe_server,
      storagePrompts.describe_server,
    );
    this.shared.register(server);
    this.working.register(server);
    this.materials.register(server);

    return server;
  }
}
