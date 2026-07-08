import { InternalApiKeyGuard } from '@lcp/shared';
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  CopyFileDto,
  DeleteFileDto,
  GetFilePropertiesDto,
  GetFileSummaryDto,
  ListFilesDto,
  MoveFileDto,
  OriginatorsDto,
  ReadFileDto,
  RestoreFileDto,
  SearchFilesDto,
  WriteFileDto,
} from './dto/storage-actions.dto';
import {
  Originators,
  StorageObject,
  StorageService,
} from '../storage/storage.service';

/** Normalises the optional `OriginatorsDto` body field into the full `Originators` shape. */
function toOriginators(dto?: OriginatorsDto): Originators | undefined {
  if (!dto) return undefined;
  return {
    user: dto.user ?? null,
    agent: dto.agent ?? null,
    task: dto.task ?? null,
  };
}

/**
 * Internal, service-to-service file-action surface backing `lcp-mcp-storage`'s
 * MCP tools (see docs/prompts/009.4). Protected by {@link InternalApiKeyGuard},
 * not JWT — callers pass `originators` explicitly in the body rather than
 * relying on a human session. `StorageProxyController` remains the
 * JWT-guarded, human/CLI-facing surface for generic get/put by key.
 */
@ApiTags('internal')
@ApiSecurity('internal-api-key')
@Controller('internal/storage')
@UseGuards(InternalApiKeyGuard)
export class StorageActionsController {
  constructor(private readonly storage: StorageService) {}

  @Post('list')
  async list(
    @Body() body: ListFilesDto,
  ): Promise<{ entries: StorageObject[] }> {
    const entries = await this.storage.listFiles(body.prefix);
    return { entries };
  }

  @Post('read')
  async read(@Body() body: ReadFileDto): Promise<{ content: string }> {
    const content = await this.storage.readFile(body.path);
    if (content === null) {
      throw new NotFoundException(`File not found: ${body.path}`);
    }
    return { content };
  }

  @Post('write')
  async write(
    @Body() body: WriteFileDto,
  ): Promise<{ key: string; size: number }> {
    return this.storage.writeFile(
      body.path,
      body.content,
      body.overwrite,
      toOriginators(body.originators),
    );
  }

  @Post('delete')
  async delete(@Body() body: DeleteFileDto): Promise<{ restorable: true }> {
    await this.storage.deleteFile(body.path, toOriginators(body.originators));
    return { restorable: true };
  }

  @Post('restore')
  async restore(@Body() body: RestoreFileDto): Promise<{ restored: true }> {
    await this.storage.restoreFile(body.path, toOriginators(body.originators));
    return { restored: true };
  }

  @Post('search')
  async search(
    @Body() body: SearchFilesDto,
  ): Promise<{ entries: StorageObject[] }> {
    const entries = await this.storage.searchFiles(body.prefix, body.pattern);
    return { entries };
  }

  @Post('properties')
  async properties(@Body() body: GetFilePropertiesDto): Promise<{
    key: string;
    exists: boolean;
    size?: number;
    contentType?: string;
    lastModified?: Date;
  }> {
    return this.storage.getFileProperties(body.path);
  }

  @Post('copy')
  async copy(@Body() body: CopyFileDto): Promise<{ copied: true }> {
    await this.storage.copyFile(
      body.source,
      body.destination,
      toOriginators(body.originators),
    );
    return { copied: true };
  }

  @Post('move')
  async move(@Body() body: MoveFileDto): Promise<{ moved: true }> {
    await this.storage.moveFile(
      body.source,
      body.destination,
      toOriginators(body.originators),
    );
    return { moved: true };
  }

  @Post('summary')
  async summary(
    @Body() body: GetFileSummaryDto,
  ): Promise<Record<string, unknown>> {
    return this.storage.getFileSummary(body.path);
  }

  @Get('exists')
  async exists(
    @Query('path') paths: string | string[] | undefined,
  ): Promise<{ missing: string[] }> {
    const normalised = !paths ? [] : Array.isArray(paths) ? paths : [paths];
    const missing = await this.storage.checkMissingFiles(normalised);
    return { missing };
  }
}
