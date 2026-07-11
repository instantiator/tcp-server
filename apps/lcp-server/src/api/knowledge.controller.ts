import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
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
import type { Request, Response } from 'express';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { DocumentSummary, KnowledgeService } from './knowledge.service';

/** Subset of the multer file object relevant to document upload. */
interface UploadedFileBuffer {
  originalname: string;
  buffer: Buffer;
}

/** Multipart body fields alongside `file` — an optional filename override. */
interface StoreKnowledgeBody {
  filename?: string;
}

/**
 * REST endpoints for managing OKF knowledge-base documents, scoped to
 * either a role (`/api/role/:roleId/knowledge`) or a company's shared
 * knowledge (`/api/company/:companyId/knowledge`). All routes require a
 * valid JWT.
 */
@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('api')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  /** Lists all OKF documents stored for the role. */
  @ApiOperation({ summary: 'List OKF documents for a role' })
  @Get('role/:roleId/knowledge')
  async listRoleKnowledge(
    @Param('roleId') roleId: UUID,
  ): Promise<DocumentSummary[]> {
    return this.knowledge.list({ kind: 'role', roleId });
  }

  /** Returns a role knowledge document's content. */
  @ApiOperation({ summary: 'Get an OKF document for a role' })
  @Get('role/:roleId/knowledge/:filename')
  async getRoleKnowledgeFile(
    @Param('roleId') roleId: UUID,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const content = await this.knowledge.get(
      { kind: 'role', roleId },
      filename,
    );
    res.setHeader('Content-Type', 'text/markdown');
    return content;
  }

  /**
   * Uploads and indexes an OKF document for the role. Accepts a
   * `multipart/form-data` request with a single `file` field. The server
   * replaces any existing document with the same filename and re-indexes
   * its RAG chunks.
   */
  @ApiOperation({ summary: 'Upload an OKF document for a role' })
  @ApiConsumes('multipart/form-data')
  @Post('role/:roleId/knowledge')
  @UseInterceptors(FileInterceptor('file'))
  async storeRoleKnowledgeFile(
    @Param('roleId') roleId: UUID,
    @UploadedFile() file: UploadedFileBuffer,
    @Body() body: StoreKnowledgeBody,
    @Req() req: Request,
  ): Promise<DocumentSummary> {
    return this.knowledge.store(
      { kind: 'role', roleId },
      body.filename ?? file.originalname,
      file.buffer,
      { user: getCurrentUserId(req), agent: null, task: null },
    );
  }

  /** Deletes a role knowledge document and its RAG chunks. Idempotent. */
  @ApiOperation({ summary: 'Delete an OKF document for a role' })
  @Delete('role/:roleId/knowledge/:filename')
  @HttpCode(204)
  async deleteRoleKnowledgeFile(
    @Param('roleId') roleId: UUID,
    @Param('filename') filename: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.knowledge.delete({ kind: 'role', roleId }, filename, {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    });
  }

  /** Lists all OKF documents stored in the company's shared knowledge. */
  @ApiOperation({ summary: 'List company-shared OKF documents' })
  @Get('company/:companyId/knowledge')
  async listCompanyKnowledge(
    @Param('companyId') companyId: string,
  ): Promise<DocumentSummary[]> {
    return this.knowledge.list({ kind: 'company', companyId });
  }

  /** Returns a company-shared knowledge document's content. */
  @ApiOperation({ summary: 'Get a company-shared OKF document' })
  @Get('company/:companyId/knowledge/:filename')
  async getCompanyKnowledgeFile(
    @Param('companyId') companyId: string,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const content = await this.knowledge.get(
      { kind: 'company', companyId },
      filename,
    );
    res.setHeader('Content-Type', 'text/markdown');
    return content;
  }

  /** Uploads and indexes an OKF document into the company's shared knowledge. */
  @ApiOperation({ summary: 'Upload a company-shared OKF document' })
  @ApiConsumes('multipart/form-data')
  @Post('company/:companyId/knowledge')
  @UseInterceptors(FileInterceptor('file'))
  async storeCompanyKnowledgeFile(
    @Param('companyId') companyId: string,
    @UploadedFile() file: UploadedFileBuffer,
    @Body() body: StoreKnowledgeBody,
    @Req() req: Request,
  ): Promise<DocumentSummary> {
    return this.knowledge.store(
      { kind: 'company', companyId },
      body.filename ?? file.originalname,
      file.buffer,
      { user: getCurrentUserId(req), agent: null, task: null },
    );
  }

  /** Deletes a company-shared knowledge document and its RAG chunks. Idempotent. */
  @ApiOperation({ summary: 'Delete a company-shared OKF document' })
  @Delete('company/:companyId/knowledge/:filename')
  @HttpCode(204)
  async deleteCompanyKnowledgeFile(
    @Param('companyId') companyId: string,
    @Param('filename') filename: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.knowledge.delete({ kind: 'company', companyId }, filename, {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    });
  }
}
