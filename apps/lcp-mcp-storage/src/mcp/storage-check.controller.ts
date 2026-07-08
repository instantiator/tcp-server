import { InternalApiKeyGuard } from '@lcp/shared';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StorageToolsService } from './storage-tools.service';

/**
 * Internal HTTP endpoint for file existence checking.
 * Called by lcp-mcp-interactions when validating `complete_task` output files.
 */
@Controller('files')
@UseGuards(InternalApiKeyGuard)
export class StorageCheckController {
  constructor(private readonly storage: StorageToolsService) {}

  /**
   * Returns paths from the query that do not exist in shared storage.
   *
   * `GET /files/exists?path=a/b.md&path=c/d.md`
   * → `{ missing: string[] }`
   */
  @Get('exists')
  async exists(
    @Query('path') paths: string | string[] | undefined,
  ): Promise<{ missing: string[] }> {
    const normalised = !paths ? [] : Array.isArray(paths) ? paths : [paths];
    const missing = await this.storage.checkMissingFiles(normalised);
    return { missing };
  }
}
