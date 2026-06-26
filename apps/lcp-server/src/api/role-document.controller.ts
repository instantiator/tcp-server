import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { UUID } from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { DocumentSummary } from './role-document.service';
import { RoleDocumentService } from './role-document.service';

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
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/role/:roleId/documents' })
export class RoleDocumentController {
  constructor(private readonly docs: RoleDocumentService) {}

  /**
   * Lists all OKF documents stored for the role.
   *
   * @returns Array of {@link DocumentSummary} objects ordered by key.
   */
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
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async storeDocument(
    @Param('roleId') roleId: UUID,
    @UploadedFile() file: UploadedFileBuffer,
  ): Promise<DocumentSummary> {
    return this.docs.storeDocument(roleId, file.originalname, file.buffer);
  }

  /**
   * Deletes one or more documents and their RAG chunks.
   *
   * Pass the `keys` array from {@link listDocuments} responses.
   * Unknown keys are silently ignored.
   */
  @Delete()
  @HttpCode(204)
  async deleteDocuments(
    @Param('roleId') roleId: UUID,
    @Body() body: DeleteDocumentsBody,
  ): Promise<void> {
    await this.docs.deleteDocuments(roleId, body.keys);
  }
}
