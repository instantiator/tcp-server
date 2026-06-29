import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { StorageToolsService } from './storage-tools.service';

/** Guards the file-existence endpoint with the internal API key header. */
@Injectable()
class InternalApiKeyGuard implements CanActivate {
  private readonly expectedKey: string;
  constructor(config: ConfigService) {
    this.expectedKey = config.getOrThrow<string>('INTERNAL_API_KEY');
  }
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-internal-api-key'];
    if (!provided)
      throw new UnauthorizedException('X-Internal-Api-Key is required');
    if (provided !== this.expectedKey)
      throw new ForbiddenException('Invalid internal API key');
    return true;
  }
}

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
