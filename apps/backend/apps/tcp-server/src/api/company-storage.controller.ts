import { streamToBuffer, type TcpCompany } from '@tcp/shared';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseBoolPipe,
  ParseFilePipeBuilder,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { zipSync } from 'fflate';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import {
  isWritable,
  MAX_ZIP_BYTES,
  purposeOf,
  toCompanyKey,
} from './company-storage-paths';
import {
  StorageFolderDto,
  StorageRestoreRequestDto,
  StorageVersionDto,
  StorageZipRequestDto,
  StoredCompanyFileDto,
} from './dto/company-storage.dto';
import { MAX_UPLOAD_BYTES } from './upload-limit';

/** The route's company, from its `:companyId` (UUID or slug). */
const SCOPE = { from: 'param', key: 'companyId', via: 'company' } as const;

const OVERWRITE = new ParseBoolPipe({ optional: true });

/** Refuses a change outside the writable folders (002.05: `resources/` only). */
function assertWritable(path: string): void {
  if (!isWritable(path)) {
    throw new ForbiddenException(`Read-only here: ${path}`);
  }
}

/**
 * Sends a download the browser saves rather than shows. Written to the
 * response directly, not returned as a `StreamableFile`: the global
 * `MaskSecretsInterceptor` would flatten one to JSON. `nosniff` stops a
 * browser guessing an uploaded file is HTML and running it.
 */
function sendAttachment(
  res: Response,
  name: string,
  type: string,
  body: Buffer | NodeJS.ReadableStream,
): void {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  if (Buffer.isBuffer(body)) res.send(body);
  else body.pipe(res);
}

/**
 * A company's shared storage, for people (002.05): the web client's storage
 * browser. Paths are relative to the company folder and checked by
 * {@link toCompanyKey}; the company is the security boundary, and only
 * `resources/` may be changed. Agents use tcp-mcp-storage instead.
 */
@ApiTags('storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller('api/company/:companyId/storage')
export class CompanyStorageController {
  constructor(
    private readonly storage: StorageService,
    private readonly db: DbService,
  ) {}

  /** One level of a folder: its subfolders, then its files, each by name. */
  @ApiOperation({ summary: 'List one level of a company storage folder' })
  @ApiOkResponse({ type: StorageFolderDto })
  @CompanyScope(SCOPE)
  @Get('folder')
  async folder(
    @Param('companyId') companyId: string,
    @Query('path') folderPath?: string,
  ): Promise<StorageFolderDto> {
    const path = folderPath ?? '';
    const company = await this.company(companyId);
    const prefix = toCompanyKey(company.slug, path, 'folder');
    const listing = await this.storage.listFolder(prefix);
    const relative = (key: string) => key.slice(company.slug.length + 1);
    const byName = (a: { name: string }, b: { name: string }) =>
      a.name.localeCompare(b.name);

    const folders = await Promise.all(
      listing.folders.map(async (key) => {
        const subfolder = relative(key);
        return {
          path: subfolder,
          name: subfolder.slice(path.length, -1),
          // Only resources carry purposes: elsewhere it would cost a read per
          // task folder, for nothing.
          purpose: isWritable(subfolder)
            ? await this.purpose(`${key}README.md`)
            : null,
        };
      }),
    );
    return {
      path,
      writable: isWritable(path),
      folders: folders.sort(byName),
      files: listing.files
        .map((f) => ({
          path: relative(f.key),
          name: f.name,
          size: f.size,
          lastModified: f.lastModified,
        }))
        .sort(byName),
    };
  }

  /** A file, or an old version of it, as a download. */
  @ApiOperation({ summary: 'Download a company storage file' })
  @ApiProduces('application/octet-stream')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @ApiQuery({ name: 'versionId', required: false, type: String })
  @CompanyScope(SCOPE)
  @Get('file')
  async download(
    @Param('companyId') companyId: string,
    @Query('path') path: string,
    @Res() res: Response,
    @Query('versionId') versionId?: string,
  ): Promise<void> {
    const company = await this.company(companyId);
    const key = toCompanyKey(company.slug, path ?? '', 'file');
    const result = await this.storage.getByKey(key, versionId);
    if (!result) throw new NotFoundException(`Not found: ${path}`);
    sendAttachment(
      res,
      path.split('/').at(-1) ?? path,
      result.contentType,
      result.stream,
    );
  }

  /** Uploads a file into a writable folder. 409 when it exists, unless `overwrite`. */
  @ApiOperation({ summary: 'Upload a file to company storage' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiQuery({ name: 'overwrite', required: false, type: Boolean })
  @ApiCreatedResponse({ type: StoredCompanyFileDto })
  @CompanyScope(SCOPE)
  @Post('file')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('companyId') companyId: string,
    @Query('path') path: string,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
        .build({ fileIsRequired: true }),
    )
    file: Express.Multer.File,
    @Req() req: Request,
    @Query('overwrite', OVERWRITE) overwrite?: boolean,
  ): Promise<StoredCompanyFileDto> {
    const company = await this.company(companyId);
    const key = toCompanyKey(company.slug, path ?? '', 'file');
    assertWritable(path);
    if (!overwrite && (await this.storage.getFileProperties(key)).exists) {
      throw new ConflictException(`Already exists: ${path}`);
    }
    const size = await this.storage.putByKey(
      key,
      file.buffer,
      file.mimetype || 'application/octet-stream',
      { user: getCurrentUserId(req), agent: null, task: null },
    );
    return { path, size };
  }

  /**
   * Soft-deletes a file, or every file under a folder (a path ending in
   * `/`). The folder `resources/` itself can't be deleted.
   */
  @ApiOperation({ summary: 'Delete a company storage file or folder' })
  @ApiNoContentResponse()
  @CompanyScope(SCOPE)
  @Delete()
  @HttpCode(204)
  async remove(
    @Param('companyId') companyId: string,
    @Query('path') path: string,
    @Req() req: Request,
  ): Promise<void> {
    const company = await this.company(companyId);
    const isFolder = (path ?? '').endsWith('/') || !path;
    const key = toCompanyKey(
      company.slug,
      path ?? '',
      isFolder ? 'folder' : 'file',
    );
    assertWritable(path);
    if (path === 'resources/') {
      throw new ForbiddenException('The resources folder itself stays');
    }
    const originators = {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    };
    if (!isFolder) return this.storage.deleteFile(key, originators);

    const files = await this.storage.listFiles(key, { all: true });
    if (files.length === 0) throw new NotFoundException(`Not found: ${path}`);
    for (const f of files) await this.storage.deleteFile(f.key, originators);
  }

  /**
   * Files and folders as one zip, entries named relative to `root`. Sizes are
   * summed before anything is read, so an oversized request costs nothing.
   */
  @ApiOperation({ summary: 'Download company storage files as a zip' })
  @ApiProduces('application/zip')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @CompanyScope(SCOPE)
  @Post('zip')
  @HttpCode(200)
  async zip(
    @Param('companyId') companyId: string,
    @Body() body: StorageZipRequestDto,
    @Res() res: Response,
  ): Promise<void> {
    const company = await this.company(companyId);
    const rootKey = toCompanyKey(company.slug, body.root, 'folder');
    const keys = new Map<string, number>();
    for (const path of body.paths) {
      if (!path.startsWith(body.root)) {
        throw new BadRequestException(`Not inside ${body.root}: ${path}`);
      }
      if (path.endsWith('/')) {
        const prefix = toCompanyKey(company.slug, path, 'folder');
        const files = await this.storage.listFiles(prefix, { all: true });
        for (const f of files) keys.set(f.key, f.size);
      } else {
        const key = toCompanyKey(company.slug, path, 'file');
        const props = await this.storage.getFileProperties(key);
        if (props.exists) keys.set(key, props.size ?? 0);
      }
    }
    if (keys.size === 0) throw new NotFoundException('Nothing to download');
    const total = [...keys.values()].reduce((sum, n) => sum + n, 0);
    if (total > MAX_ZIP_BYTES) {
      throw new PayloadTooLargeException(
        `${total} bytes is over the ${MAX_ZIP_BYTES}-byte zip limit`,
      );
    }

    // ponytail: built in memory, capped by MAX_ZIP_BYTES; stream it if a real
    // download hits the cap.
    const entries: Record<string, Uint8Array> = {};
    for (const key of keys.keys()) {
      const object = await this.storage.getByKey(key);
      if (object) {
        entries[key.slice(rootKey.length)] = await streamToBuffer(
          object.stream,
        );
      }
    }
    sendAttachment(
      res,
      'files.zip',
      'application/zip',
      Buffer.from(zipSync(entries)),
    );
  }

  /** Every kept version of a file, newest first. */
  @ApiOperation({ summary: 'List the versions of a company storage file' })
  @ApiOkResponse({ type: StorageVersionDto, isArray: true })
  @CompanyScope(SCOPE)
  @Get('versions')
  async versions(
    @Param('companyId') companyId: string,
    @Query('path') path: string,
  ): Promise<StorageVersionDto[]> {
    const company = await this.company(companyId);
    return this.storage.listVersions(
      toCompanyKey(company.slug, path ?? '', 'file'),
    );
  }

  /** Makes an old version current again; the version it replaces is kept. */
  @ApiOperation({ summary: 'Restore an old version of a company storage file' })
  @ApiCreatedResponse({ type: StoredCompanyFileDto })
  @CompanyScope(SCOPE)
  @Post('restore')
  async restore(
    @Param('companyId') companyId: string,
    @Body() body: StorageRestoreRequestDto,
    @Req() req: Request,
  ): Promise<StoredCompanyFileDto> {
    const company = await this.company(companyId);
    const key = toCompanyKey(company.slug, body.path, 'file');
    assertWritable(body.path);
    await this.storage.restoreVersion(key, body.versionId, {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    });
    return { path: body.path };
  }

  /** The company a route names, by id or slug. */
  private async company(idOrSlug: string): Promise<TcpCompany> {
    const company = await this.db.getCompany(idOrSlug);
    if (!company) throw new NotFoundException(`Company not found: ${idOrSlug}`);
    return company;
  }

  /** A folder's purpose from its README, or `null` when it has none. */
  private async purpose(readmeKey: string): Promise<string | null> {
    const readme = await this.storage.readFile(readmeKey);
    return readme === null ? null : purposeOf(readme) || null;
  }
}
