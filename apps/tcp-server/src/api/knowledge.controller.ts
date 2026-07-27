import * as path from 'path';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
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
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import type { UUID } from 'crypto';
import type { Request, Response } from 'express';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RagChunk } from '../rag/rag-retrieval.service';
import { Originators } from '../storage/storage.service';
import {
  ensureOkfFrontMatter,
  convertToMarkdown,
} from './knowledge-conversion';
import {
  CompanyKnowledgeStatus,
  DocumentSummary,
  KnowledgeScopeRef,
  KnowledgeService,
  KnowledgeStatus,
} from './knowledge.service';
import { setWarningsHeader } from './validation-warnings';

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
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary[]> {
    const ref: KnowledgeScopeRef = { kind: 'role', roleId };
    const result = await this.knowledge.list(ref);
    await this.reportEmbeddingWarnings(ref, res);
    return result;
  }

  /**
   * Reports knowledge-index status for a role: document/chunk counts, size,
   * generation, last successful rebuild, and whether one is in progress.
   * Registered before the `:filename` route below so `status` is never
   * mistaken for a filename.
   */
  @ApiOperation({ summary: 'Get knowledge index status for a role' })
  @Get('role/:roleId/knowledge/status')
  async getRoleKnowledgeStatus(
    @Param('roleId') roleId: UUID,
    @Res({ passthrough: true }) res: Response,
  ): Promise<KnowledgeStatus> {
    const ref: KnowledgeScopeRef = { kind: 'role', roleId };
    const result = await this.knowledge.status(ref);
    await this.reportEmbeddingWarnings(ref, res);
    return result;
  }

  /**
   * Runs a RAG similarity search for the role and returns the raw chunks —
   * the same data prompt assembly would inject, without invoking any
   * chat/LLM call. Searches the role's own chunks plus its company's shared
   * chunks (see {@link RagRetrievalService.retrieve}), so this one route
   * covers both "what would this role see" and "what's in the shared pool";
   * a separate company-shared-only route would be redundant.
   *
   * Registered before the `:filename` route below so `query` is never
   * mistaken for a filename.
   *
   * @throws {@link BadRequestException} when `q` is missing.
   * @throws {@link NotFoundException} when the role does not exist.
   */
  @ApiOperation({ summary: 'Query the RAG index for a role' })
  @Get('role/:roleId/knowledge/query')
  async queryRoleKnowledge(
    @Param('roleId') roleId: UUID,
    @Res({ passthrough: true }) res: Response,
    @Query('q') q?: string,
    @Query('topK') topK?: string,
    @Query('threshold') threshold?: string,
  ): Promise<RagChunk[]> {
    if (!q) throw new BadRequestException('Query parameter `q` is required');
    const result = await this.knowledge.queryRag(
      roleId,
      q,
      topK !== undefined ? Number(topK) : undefined,
      threshold !== undefined ? Number(threshold) : undefined,
    );
    await this.reportEmbeddingWarnings({ kind: 'role', roleId }, res);
    return result;
  }

  /** Returns a role knowledge document's content. */
  @ApiOperation({ summary: 'Get an OKF document for a role' })
  @Get('role/:roleId/knowledge/:filename')
  async getRoleKnowledgeFile(
    @Param('roleId') roleId: UUID,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const ref: KnowledgeScopeRef = { kind: 'role', roleId };
    const content = await this.knowledge.get(ref, filename);
    res.setHeader('Content-Type', 'text/markdown');
    await this.reportEmbeddingWarnings(ref, res);
    return content;
  }

  /**
   * Uploads and indexes a document for the role. Accepts a
   * `multipart/form-data` request with a single `file` field, in any of
   * `SUPPORTED_EXTENSIONS` (see `knowledge-conversion.ts`) — the server
   * converts it to OKF Markdown before storing (see
   * {@link storeConverted}). The server replaces any existing document with
   * the same filename and re-indexes its RAG chunks.
   */
  @ApiOperation({ summary: 'Upload a document for a role' })
  @ApiConsumes('multipart/form-data')
  @Post('role/:roleId/knowledge')
  @UseInterceptors(FileInterceptor('file'))
  async storeRoleKnowledgeFile(
    @Param('roleId') roleId: UUID,
    @UploadedFile() file: UploadedFileBuffer,
    @Body() body: StoreKnowledgeBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary> {
    return this.storeConverted(
      { kind: 'role', roleId },
      file,
      body.filename,
      { user: getCurrentUserId(req), agent: null, task: null },
      res,
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
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const ref: KnowledgeScopeRef = { kind: 'role', roleId };
    await this.knowledge.delete(ref, filename, {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    });
    await this.reportEmbeddingWarnings(ref, res);
  }

  /** Lists all OKF documents stored in the company's shared knowledge. */
  @ApiOperation({ summary: 'List company-shared OKF documents' })
  @Get('company/:companyId/knowledge')
  async listCompanyKnowledge(
    @Param('companyId') companyId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary[]> {
    const ref: KnowledgeScopeRef = { kind: 'company', companyId };
    const result = await this.knowledge.list(ref);
    await this.reportEmbeddingWarnings(ref, res);
    return result;
  }

  /**
   * Reports knowledge-index status for the company's shared scope plus
   * every role. Registered before the `:filename` route below so `status`
   * is never mistaken for a filename.
   */
  @ApiOperation({
    summary: 'Get knowledge index status for a company (shared + every role)',
  })
  @Get('company/:companyId/knowledge/status')
  async getCompanyKnowledgeStatus(
    @Param('companyId') companyId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CompanyKnowledgeStatus> {
    const result = await this.knowledge.statusForCompany(companyId);
    await this.reportEmbeddingWarnings({ kind: 'company', companyId }, res);
    return result;
  }

  /** Returns a company-shared knowledge document's content. */
  @ApiOperation({ summary: 'Get a company-shared OKF document' })
  @Get('company/:companyId/knowledge/:filename')
  async getCompanyKnowledgeFile(
    @Param('companyId') companyId: string,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const ref: KnowledgeScopeRef = { kind: 'company', companyId };
    const content = await this.knowledge.get(ref, filename);
    res.setHeader('Content-Type', 'text/markdown');
    await this.reportEmbeddingWarnings(ref, res);
    return content;
  }

  /**
   * Uploads and indexes a document into the company's shared knowledge —
   * see {@link storeRoleKnowledgeFile} for the accepted formats and
   * conversion behaviour.
   */
  @ApiOperation({ summary: 'Upload a company-shared document' })
  @ApiConsumes('multipart/form-data')
  @Post('company/:companyId/knowledge')
  @UseInterceptors(FileInterceptor('file'))
  async storeCompanyKnowledgeFile(
    @Param('companyId') companyId: string,
    @UploadedFile() file: UploadedFileBuffer,
    @Body() body: StoreKnowledgeBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DocumentSummary> {
    return this.storeConverted(
      { kind: 'company', companyId },
      file,
      body.filename,
      { user: getCurrentUserId(req), agent: null, task: null },
      res,
    );
  }

  /**
   * Rebuilds every knowledge scope of the company (shared + each role):
   * bumps their generations and enqueues rebuild jobs. Returns 202 — indexing
   * happens asynchronously on the reindex worker.
   */
  @ApiOperation({ summary: 'Reindex all knowledge for a company' })
  @Post('company/:companyId/knowledge/reindex')
  @HttpCode(202)
  async reindexCompanyKnowledge(
    @Param('companyId') companyId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ reindexing: true }> {
    await this.knowledge.reindexCompany(companyId);
    await this.reportEmbeddingWarnings({ kind: 'company', companyId }, res);
    return { reindexing: true };
  }

  /** Deletes a company-shared knowledge document and its RAG chunks. Idempotent. */
  @ApiOperation({ summary: 'Delete a company-shared OKF document' })
  @Delete('company/:companyId/knowledge/:filename')
  @HttpCode(204)
  async deleteCompanyKnowledgeFile(
    @Param('companyId') companyId: string,
    @Param('filename') filename: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const ref: KnowledgeScopeRef = { kind: 'company', companyId };
    await this.knowledge.delete(ref, filename, {
      user: getCurrentUserId(req),
      agent: null,
      task: null,
    });
    await this.reportEmbeddingWarnings(ref, res);
  }

  /**
   * Converts an uploaded file to OKF Markdown and stores it. The target
   * filename is `overrideFilename` if given (preserving today's explicit
   * overwrite behaviour); otherwise it's the source basename with a `.md`
   * extension, regardless of the source's own extension (e.g. `report.pdf`
   * → `report.md`).
   *
   * When no override is given and the source wasn't already `.md` (i.e. a
   * real conversion happened), a same-named existing document is treated as
   * an accidental collision rather than an update — it throws
   * {@link ConflictException} rather than silently overwriting a
   * differently-sourced file. Re-uploading the same source again still
   * overwrites, as does passing an explicit `filename`.
   *
   * `KnowledgeService.store` → `StorageService.putKnowledgeFile` already
   * runs the authoritative `validateOkf` check (via the shared validation
   * registry) before writing, so no separate validation call is needed here.
   */
  private async storeConverted(
    ref: KnowledgeScopeRef,
    file: UploadedFileBuffer,
    overrideFilename: string | undefined,
    originators: Originators,
    res: Response,
  ): Promise<DocumentSummary> {
    const ext = path.extname(file.originalname).toLowerCase();
    const converted = await convertToMarkdown(file.originalname, file.buffer);
    // .md sources pass through unchanged (see convertToMarkdown) and keep
    // today's strict behaviour: KnowledgeService.store's validateOkf gate
    // rejects a missing/invalid title rather than heuristically inventing
    // one. Front-matter generation only applies to genuinely converted
    // formats, which have no native front-matter concept of their own.
    const content =
      ext === '.md'
        ? converted.body
        : ensureOkfFrontMatter(file.originalname, converted);

    const targetFilename =
      overrideFilename ??
      (ext === '.md'
        ? file.originalname
        : `${path.basename(file.originalname, ext)}.md`);

    if (!overrideFilename && ext !== '.md') {
      const existing = await this.knowledge.list(ref);
      if (existing.some((doc) => doc.name === targetFilename)) {
        throw new ConflictException(
          `A document named '${targetFilename}' already exists. Delete it ` +
            `first, or pass an explicit filename to overwrite intentionally.`,
        );
      }
    }

    const summary = await this.knowledge.store(
      ref,
      targetFilename,
      Buffer.from(content, 'utf-8'),
      originators,
    );
    await this.reportEmbeddingWarnings(ref, res);
    return summary;
  }

  /**
   * Sets `X-Tcp-Warnings` for this scope — whether RAG indexing is
   * configured at all, and whether the most recent rebuild failed (e.g. the
   * embedding endpoint was unreachable). Called by every knowledge endpoint
   * so these otherwise-invisible failure modes are always visible, not just
   * from the status endpoint (see {@link KnowledgeService.embeddingWarnings}).
   */
  private async reportEmbeddingWarnings(
    ref: KnowledgeScopeRef,
    res: Response,
  ): Promise<void> {
    setWarningsHeader(res, await this.knowledge.embeddingWarnings(ref));
  }
}
