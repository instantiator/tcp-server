import { InternalApiKeyGuard } from '@tcp/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import {
  AppendFileDto,
  CopyFileDto,
  DeleteFileDto,
  GetFilePropertiesDto,
  GetFileSummaryDto,
  ListFilesDto,
  MoveFileDto,
  OriginatorsDto,
  ReadFileDto,
  ReplaceFileDto,
  RestoreFileDto,
  SearchFilesDto,
  WriteFileDto,
} from './dto/storage-actions.dto';
import {
  AppendFileResponseDto,
  FileContentResponseDto,
  FileCopiedResponseDto,
  FileDeletedResponseDto,
  FileMovedResponseDto,
  FilePropertiesResponseDto,
  FileRestoredResponseDto,
  MissingFilesResponseDto,
  ReplaceFileResponseDto,
  StorageEntriesResponseDto,
  StoredObjectResponseDto,
} from './dto/storage-response.dto';
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
 * Internal, service-to-service file-action surface backing `tcp-mcp-storage`'s
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

  @ApiCreatedResponse({ type: StorageEntriesResponseDto })
  @Post('list')
  async list(
    @Body() body: ListFilesDto,
  ): Promise<{ entries: StorageObject[] }> {
    const entries = await this.storage.listFiles(body.prefix);
    return { entries };
  }

  @ApiCreatedResponse({ type: FileContentResponseDto })
  @Post('read')
  async read(@Body() body: ReadFileDto): Promise<{ content: string }> {
    const content = await this.storage.readFile(body.path);
    if (content === null) {
      throw new NotFoundException(`File not found: ${body.path}`);
    }
    return { content };
  }

  @ApiCreatedResponse({ type: StoredObjectResponseDto })
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

  @ApiCreatedResponse({ type: FileDeletedResponseDto })
  @Post('delete')
  async delete(@Body() body: DeleteFileDto): Promise<{ restorable: true }> {
    await this.storage.deleteFile(body.path, toOriginators(body.originators));
    return { restorable: true };
  }

  @ApiCreatedResponse({ type: FileRestoredResponseDto })
  @Post('restore')
  async restore(@Body() body: RestoreFileDto): Promise<{ restored: true }> {
    await this.storage.restoreFile(body.path, toOriginators(body.originators));
    return { restored: true };
  }

  /**
   * Appends text to an object, creating it when absent. A read-modify-write
   * variant of `write` — the combined document is validated exactly as a
   * direct write, so an append that breaks the document's format is rejected.
   */
  @ApiCreatedResponse({ type: AppendFileResponseDto })
  @Post('append')
  async append(
    @Body() body: AppendFileDto,
  ): Promise<{ key: string; size: number; created: boolean }> {
    const existing = await this.storage.readFile(body.path);
    const combined = (existing ?? '') + body.content;
    const result = await this.storage.writeFile(
      body.path,
      combined,
      true,
      toOriginators(body.originators),
    );
    return { ...result, created: existing === null };
  }

  /**
   * Replaces every occurrence of the literal string `find` in an object and
   * writes the result back (validated as a normal write). Fails if the file is
   * missing or `find` occurs zero times; returns the replacement count.
   */
  @ApiCreatedResponse({ type: ReplaceFileResponseDto })
  @Post('replace')
  async replace(
    @Body() body: ReplaceFileDto,
  ): Promise<{ key: string; count: number }> {
    if (body.find === '') {
      throw new BadRequestException('The find string must not be empty.');
    }
    const existing = await this.storage.readFile(body.path);
    if (existing === null) {
      throw new NotFoundException(
        `File not found: ${body.path}. Nothing to replace in.`,
      );
    }
    const count = existing.split(body.find).length - 1;
    if (count === 0) {
      throw new BadRequestException(
        `The string "${body.find}" does not occur in ${body.path}; nothing was replaced.`,
      );
    }
    const updated = existing.split(body.find).join(body.replace);
    const result = await this.storage.writeFile(
      body.path,
      updated,
      true,
      toOriginators(body.originators),
    );
    return { key: result.key, count };
  }

  @ApiCreatedResponse({ type: StorageEntriesResponseDto })
  @Post('search')
  async search(
    @Body() body: SearchFilesDto,
  ): Promise<{ entries: StorageObject[] }> {
    const entries = await this.storage.searchFiles(body.prefix, body.pattern);
    return { entries };
  }

  @ApiCreatedResponse({ type: FilePropertiesResponseDto })
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

  @ApiCreatedResponse({ type: FileCopiedResponseDto })
  @Post('copy')
  async copy(@Body() body: CopyFileDto): Promise<{ copied: true }> {
    await this.storage.copyFile(
      body.source,
      body.destination,
      toOriginators(body.originators),
    );
    return { copied: true };
  }

  @ApiCreatedResponse({ type: FileMovedResponseDto })
  @Post('move')
  async move(@Body() body: MoveFileDto): Promise<{ moved: true }> {
    await this.storage.moveFile(
      body.source,
      body.destination,
      toOriginators(body.originators),
    );
    return { moved: true };
  }

  // The common fields are fixed; each format adds its own (`columns` and
  // `rowCount` for CSV, `headings` for Markdown, …; see
  // storage/content-analysis/). A raw schema, because a class can't say "and
  // any other properties".
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      required: ['path', 'contentType'],
      properties: {
        path: { type: 'string' },
        size: { type: 'number' },
        contentType: { type: 'string' },
        format: {
          type: 'string',
          description:
            'csv, csv-invalid, markdown, text, typescript, yaml, json-array, json-object or json-invalid',
        },
      },
      additionalProperties: true,
    },
  })
  @Post('summary')
  async summary(
    @Body() body: GetFileSummaryDto,
  ): Promise<Record<string, unknown>> {
    return this.storage.getFileSummary(body.path);
  }

  @ApiOkResponse({ type: MissingFilesResponseDto })
  @ApiQuery({
    name: 'path',
    type: String,
    isArray: true,
    required: false,
    description: 'Repeat to ask about several paths',
  })
  @Get('exists')
  async exists(
    @Query('path') paths: string | string[] | undefined,
  ): Promise<{ missing: string[] }> {
    const normalised = !paths ? [] : Array.isArray(paths) ? paths : [paths];
    const missing = await this.storage.checkMissingFiles(normalised);
    return { missing };
  }
}
