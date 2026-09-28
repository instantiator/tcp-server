import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  ParseFilePipeBuilder,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import * as path from 'path';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { StorageService } from '../storage/storage.service';
import { StoredObjectResponseDto } from './dto/storage-response.dto';

/** Maximum upload size accepted by {@link StorageProxyController.upload}. */
// eslint-disable-next-line no-useless-assignment -- read inside a parameter decorator's argument, which this rule's flow analysis doesn't see as a use.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Validates that a storage path is safe: non-empty, no leading slash,
 * and no `.` or `..` path segments.
 */
function assertSafePath(p: string): void {
  if (
    !p ||
    p.startsWith('/') ||
    p.split('/').some((s) => s === '.' || s === '..')
  ) {
    throw new BadRequestException('Invalid storage path');
  }
}

/**
 * Proxies shared-storage access for the CLI.
 *
 * `GET  /api/storage?path=<key>` — download a file from MinIO.
 * `POST /api/storage/:path`      — upload a file to MinIO (multipart `file` field).
 *
 * Both endpoints require a valid JWT.
 */
@ApiTags('storage')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/storage' })
export class StorageProxyController {
  constructor(private readonly storage: StorageService) {}

  /**
   * Downloads the object at `path` from shared storage and streams it to the
   * response. Returns 404 when the key does not exist.
   */
  @ApiOperation({ summary: 'Download a file from shared storage' })
  @CompanyScope({ from: 'query', key: 'path', via: 'storagePath' })
  @Get()
  async download(
    @Query('path') objectPath: string,
    @Res() res: Response,
  ): Promise<void> {
    assertSafePath(objectPath);
    const result = await this.storage.getByKey(objectPath);
    if (!result) throw new NotFoundException(`Not found: ${objectPath}`);

    const filename = path.basename(objectPath);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    result.stream.pipe(res);
  }

  /**
   * Uploads `file` (multipart) to the given `path` in shared storage.
   * Returns `{ key, size }` on success.
   */
  @ApiOperation({ summary: 'Upload a file to shared storage' })
  @ApiConsumes('multipart/form-data')
  @CompanyScope({ from: 'query', key: 'path', via: 'storagePath' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @Post()
  @ApiCreatedResponse({ type: StoredObjectResponseDto })
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Query('path') objectPath: string,
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: MAX_UPLOAD_BYTES })
        .build({ fileIsRequired: true }),
    )
    file: Express.Multer.File,
    @Req() req: Request,
  ): Promise<{ key: string; size: number }> {
    assertSafePath(objectPath);
    const size = await this.storage.putByKey(
      objectPath,
      file.buffer,
      file.mimetype,
      { user: getCurrentUserId(req), agent: null, task: null },
    );
    return { key: objectPath, size };
  }
}
