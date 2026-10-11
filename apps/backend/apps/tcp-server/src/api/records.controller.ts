import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Patch,
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
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AddRecordDto,
  AppendRecordsCsvResultDto,
  CreateRecordTableDto,
  RecordTableDefinitionDto,
  RecordFieldSchemaDto,
  RecordTableRowsDto,
  RecordTableSummaryDto,
  RemovedRecordsDto,
  TimedRecordDto,
  UpdateRecordDto,
} from './dto/records.dto';
import { type RecordsDownload, RecordsApiService } from './records-api.service';

/** The largest CSV an append accepts; multer stops reading past it (413). */
const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** The route's company, from its `:companyId` (UUID or slug). */
const SCOPE = { from: 'param', key: 'companyId', via: 'company' } as const;

/**
 * Sends a download as a file the browser saves rather than shows. Written to
 * the response directly, not returned as a `StreamableFile`: the global
 * `MaskSecretsInterceptor` walks returned values and would flatten one to JSON.
 */
function sendAttachment(
  res: Response,
  download: RecordsDownload,
  type: string,
): void {
  res.setHeader('Content-Type', type);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${download.filename}"`,
  );
  res.send(Buffer.from(download.body));
}

/**
 * A company's record tables, for people (001.03): the web UI's spreadsheet
 * and the CLI's export. Agents reach the same tables through tcp-mcp-records.
 */
@ApiTags('records')
@ApiBearerAuth()
@ApiExtraModels(RecordFieldSchemaDto)
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller('api/company/:companyId/records')
export class RecordsController {
  constructor(private readonly records: RecordsApiService) {}

  /** The company's tables, with how many records each holds. */
  @ApiOperation({ summary: "List a company's record tables" })
  @ApiOkResponse({ type: RecordTableSummaryDto, isArray: true })
  @CompanyScope(SCOPE)
  @Get('tables')
  async listTables(@Param('companyId') companyId: string) {
    return this.records.listTables(await this.records.company(companyId));
  }

  /**
   * Makes a table from a JSON Schema, as an agent's `create_table` does. The
   * web UI has no form for it yet; tests and tools use it.
   */
  @ApiOperation({ summary: 'Create a record table' })
  @ApiCreatedResponse({ type: RecordTableDefinitionDto })
  @CompanyScope(SCOPE)
  @Post('tables')
  async createTable(
    @Param('companyId') companyId: string,
    @Body() body: CreateRecordTableDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.createTable(company, body, getCurrentUserId(req));
  }

  /** Every table as a zip of CSVs. */
  @ApiOperation({ summary: 'Download every record table as a zip of CSVs' })
  @ApiProduces('application/zip')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @CompanyScope(SCOPE)
  @Get('export')
  async export(
    @Param('companyId') companyId: string,
    @Res() res: Response,
  ): Promise<void> {
    const company = await this.records.company(companyId);
    sendAttachment(
      res,
      await this.records.exportZip(company),
      'application/zip',
    );
  }

  /** A table's definition and rows, most recently changed first (10,000 at most). */
  @ApiOperation({ summary: 'Read a record table' })
  @ApiOkResponse({ type: RecordTableRowsDto })
  @CompanyScope(SCOPE)
  @Get('tables/:table')
  async readTable(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
  ) {
    return this.records.readTable(await this.records.company(companyId), table);
  }

  /** Deletes a table and every record in it. */
  @ApiOperation({ summary: 'Delete a record table' })
  @ApiOkResponse({ type: RemovedRecordsDto })
  @CompanyScope(SCOPE)
  @Delete('tables/:table')
  async dropTable(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.dropTable(company, table, getCurrentUserId(req));
  }

  /** One table as CSV. */
  @ApiOperation({ summary: 'Download a record table as CSV' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @CompanyScope(SCOPE)
  @Get('tables/:table/csv')
  async tableCsv(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Res() res: Response,
  ): Promise<void> {
    const company = await this.records.company(companyId);
    sendAttachment(
      res,
      await this.records.tableCsv(company, table),
      'text/csv; charset=utf-8',
    );
  }

  /**
   * Adds every row of a CSV file, or none. The first line names the columns;
   * a row whose key is already held is skipped and counted.
   */
  @ApiOperation({ summary: 'Append CSV rows to a record table' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({ type: AppendRecordsCsvResultDto })
  @CompanyScope(SCOPE)
  @Post('tables/:table/csv')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES } }),
  )
  async appendCsv(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.appendCsv(
      company,
      table,
      file?.buffer ?? Buffer.alloc(0),
      getCurrentUserId(req),
    );
  }

  /** Adds one record. */
  @ApiOperation({ summary: 'Add a record' })
  @ApiCreatedResponse({ type: TimedRecordDto })
  @CompanyScope(SCOPE)
  @Post('tables/:table/rows')
  async addRow(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Body() body: AddRecordDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.addRow(
      company,
      table,
      body.data,
      getCurrentUserId(req),
    );
  }

  /** Deletes every record of a table, keeping the table. */
  @ApiOperation({ summary: 'Clear a record table' })
  @ApiOkResponse({ type: RemovedRecordsDto })
  @CompanyScope(SCOPE)
  @Delete('tables/:table/rows')
  async clearTable(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.clearTable(company, table, getCurrentUserId(req));
  }

  /** Changes a record. 409 when it has changed since `version`. */
  @ApiOperation({ summary: 'Change a record' })
  @ApiOkResponse({ type: TimedRecordDto })
  @CompanyScope(SCOPE)
  @Patch('tables/:table/rows/:id')
  async updateRow(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Param('id') id: string,
    @Body() body: UpdateRecordDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.updateRow(
      company,
      table,
      id,
      body.changes,
      body.version,
      getCurrentUserId(req),
    );
  }

  /** Deletes a record. 409 when it has changed since `version`. */
  @ApiOperation({ summary: 'Delete a record' })
  @ApiNoContentResponse()
  @CompanyScope(SCOPE)
  @HttpCode(204)
  @Delete('tables/:table/rows/:id')
  async deleteRow(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Param('id') id: string,
    @Query('version', ParseIntPipe) version: number,
    @Req() req: Request,
  ): Promise<void> {
    const company = await this.records.company(companyId);
    await this.records.deleteRow(
      company,
      table,
      id,
      version,
      getCurrentUserId(req),
    );
  }
}
