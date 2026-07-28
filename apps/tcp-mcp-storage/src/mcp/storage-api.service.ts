import { Injectable } from '@nestjs/common';
import { InternalApiClient } from '@tcp/shared';

/** Shape of a single entry returned by list/search tools. */
export interface FileEntry {
  key: string;
  name: string;
  size: number;
  lastModified: string;
}

/** Properties returned by get_file_properties. */
export interface FileProperties {
  key: string;
  exists: boolean;
  size?: number;
  contentType?: string;
  lastModified?: string;
}

/** A material resolved server-side to a concrete key (or literal inline text). */
export interface ResolvedMaterial {
  name: string;
  key: string | null;
  inlineText?: string;
}

/** The caller's storage scope, resolved by `GET /internal/agent/:id/storage-scope`. */
export interface StorageScope {
  mode: string;
  readOnly: boolean;
  workingPrefix: string;
  materials: ResolvedMaterial[];
}

/**
 * The one place this MCP server talks to tcp-server. All file-action logic
 * (validation, soft-delete, content analysis, audit) lives behind
 * `/internal/storage/*`, and every agent's storage scope behind
 * `/internal/agent/:id/storage-scope` — nothing is decided locally.
 */
@Injectable()
export class StorageApiService {
  constructor(private readonly api: InternalApiClient) {}

  /** Performs one storage action on tcp-server's behalf-of-the-agent endpoint. */
  post<T>(action: string, body: unknown): Promise<T> {
    return this.api.post<T>(`/internal/storage/${action}`, body);
  }

  /** Resolves the caller's storage scope for the current tool call. */
  fetchScope(agentId: string): Promise<StorageScope> {
    return this.api.get<StorageScope>(
      `/internal/agent/${agentId}/storage-scope`,
    );
  }
}
