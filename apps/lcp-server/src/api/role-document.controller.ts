import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConsumes,
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { UUID } from 'crypto';
import type { Request } from 'express';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  RoleDocumentService,
  type DocumentSummary,
} from './role-document.service';

/** Subset of the multer file object relevant to document upload. */
interface UploadedFileBuffer {
  originalname: string;
  buffer: Buffer;
}

/** Request body for bulk-delete of role documents. */
interface DeleteDocumentsBody {
  /** Full MinIO object keys to delete (as returned by {@link listDocuments}). */
  keys: string[];
}

/**
 * REST endpoints for managing OKF knowledge-base documents for a role.
 *
 * All routes are under `/api/role/:roleId/documents` and require a valid JWT.
 */
@ApiTags('role-documents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/role/:roleId/documents' })
export class RoleDocumentController {
  constructor(private readonly docs: RoleDocumentService) {}

  /**
   * Lists all OKF documents stored for the role.
   *
   * @returns Array of {@link DocumentSummary} objects ordered by key.
   */
  @ApiOperation({ summary: 'List OKF documents for a role' })
  @Get()
  async listDocuments(
    @Param('roleId') roleId: UUID,
  ): Promise<DocumentSummary[]> {
    return this.docs.listDocuments(roleId);
  }

  /**
   * Uploads and indexes an OKF document for the role.
   *
   * Accepts a `multipart/form-data` request with a single `file` field
   * containing the Markdown document. The server replaces any existing
   * document with the same filename and re-indexes its RAG chunks.
   *
   * @returns The {@link DocumentSummary} for the stored document.
   */
  @ApiOperation({ summary: 'Upload an OKF document for a role' })
  @ApiConsumes('multipart/form-data')
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async storeDocument(
    @Param('roleId') roleId: UUID,
    @UploadedFile() file: UploadedFileBuffer,
    @Req() req: Request,
  ): Promise<DocumentSummary> {
    return this.docs.storeDocument(roleId, file.originalname, file.buffer, {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    });
  }

  /**
   * Deletes one or more documents and their RAG chunks.
   *
   * Pass the `keys` array from {@link listDocuments} responses.
   * Unknown keys are silently ignored.
   */
  @ApiOperation({ summary: 'Delete OKF documents for a role' })
  @Delete()
  @HttpCode(204)
  async deleteDocuments(
    @Param('roleId') roleId: UUID,
    @Body() body: DeleteDocumentsBody,
  ): Promise<void> {
    await this.docs.deleteDocuments(roleId, body.keys);
  }
}
