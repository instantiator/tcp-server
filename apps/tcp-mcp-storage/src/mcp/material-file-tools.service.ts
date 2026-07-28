import { Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolResult, extractServerErrorMessage, ok } from '@tcp/shared';
import { storageToolDescriptions } from '../storage-tool-descriptions';
import {
  FileProperties,
  ResolvedMaterial,
  StorageApiService,
  StorageScope,
} from './storage-api.service';

/**
 * The assignment-scoped materials tier: read-only access to the inputs the
 * planner attached to this assignment, addressed by the stable name shown in
 * the agent's prompt rather than by storage key. Inline-text materials are
 * served straight from the scope, never from storage.
 *
 * The `agentId` field on these tools is injected server-side by
 * McpClientService and never supplied by the model.
 */
@Injectable()
export class MaterialFileToolsService {
  constructor(private readonly storage: StorageApiService) {}

  /** Registers this tier's tools on a fresh server instance. */
  register(server: McpServer): void {
    server.registerTool(
      'list_material_files',
      {
        description: storageToolDescriptions.list_material_files,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
        },
      },
      ({ agentId }) => this.listMaterialFiles(agentId),
    );

    server.registerTool(
      'get_material_file_properties',
      {
        description: storageToolDescriptions.get_material_file_properties,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z.string().describe('The material name to inspect.'),
        },
      },
      ({ agentId, filename }) =>
        this.getMaterialFileProperties(agentId, filename),
    );

    server.registerTool(
      'read_material_file',
      {
        description: storageToolDescriptions.read_material_file,
        inputSchema: {
          agentId: z.uuid().describe('The calling agent UUID.'),
          filename: z.string().describe('The material name to read.'),
        },
      },
      ({ agentId, filename }) => this.readMaterialFile(agentId, filename),
    );
  }

  async listMaterialFiles(agentId: string): Promise<ToolResult> {
    try {
      const scope = await this.storage.fetchScope(agentId);
      const list = scope.materials.map((m) => ({
        name: m.name,
        kind: m.key === null ? 'inline-text' : 'file',
      }));
      return ok(JSON.stringify(list, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async getMaterialFileProperties(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.storage.fetchScope(agentId);
      const material = this.findMaterial(scope, filename);
      if (!material) return ok(materialNotFound(filename));
      if (material.key === null) {
        return ok(
          JSON.stringify(
            {
              name: material.name,
              kind: 'inline-text',
              exists: true,
              size: Buffer.byteLength(material.inlineText ?? '', 'utf-8'),
            },
            null,
            2,
          ),
        );
      }
      const props = await this.storage.post<FileProperties>('properties', {
        path: material.key,
      });
      return ok(JSON.stringify(props, null, 2));
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  async readMaterialFile(
    agentId: string,
    filename: string,
  ): Promise<ToolResult> {
    try {
      const scope = await this.storage.fetchScope(agentId);
      const material = this.findMaterial(scope, filename);
      if (!material) return ok(materialNotFound(filename));
      if (material.key === null) {
        return ok(material.inlineText ?? '');
      }
      const { content } = await this.storage.post<{ content: string }>('read', {
        path: material.key,
      });
      return ok(content);
    } catch (e) {
      return ok(extractServerErrorMessage(e));
    }
  }

  private findMaterial(
    scope: StorageScope,
    name: string,
  ): ResolvedMaterial | undefined {
    return scope.materials.find((m) => m.name === name);
  }
}

/** Points the model at the tool that lists what it may actually address. */
function materialNotFound(name: string): string {
  return `No material named '${name}'. Use list_material_files to see the available materials.`;
}
