import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  Patch,
  Post,
  Put,
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
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import { CompanyScope } from '../auth/company-scope.decorator';
import { getCurrentUserId } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  AddColumnDto,
  AddDoNotStoreDto,
  AddRecordDto,
  AppendRecordsCsvResultDto,
  CreateRecordTableDto,
  DeleteRecordsDto,
  DoNotStoreEntryDto,
  ExportRecordsDto,
  RecordSearchResultDto,
  RecordTableDefinitionDto,
  RecordFieldSchemaDto,
  RecordTableRowsDto,
  RecordTableSummaryDto,
  RemovedRecordsDto,
  RenameColumnDto,
  SearchRecordsDto,
  SetPrimaryKeyDto,
  SetRetentionDto,
  TimedRecordDto,
  UpdateDoNotStoreDto,
  UpdateRecordDto,
} from './dto/records.dto';
import { type RecordsDownload, RecordsApiService } from './records-api.service';

/** The largest CSV an append accepts; multer stops reading past it (413). */
const MAX_CSV_BYTES = 5 * 1024 * 1024;

/**
 * `?confirmDoNotStore=true`: the person has seen that the data matches the
 * do-not-store list and stores it anyway. Without it, a match is a 409.
 */
const CONFIRM = new ParseBoolPipe({ optional: true });
const CONFIRM_QUERY = {
  name: 'confirmDoNotStore',
  required: false,
  type: Boolean,
  description:
    'Store data that matches the do-not-store list; without it a match is refused with 409 `do_not_store`.',
} as const;

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
  @ApiQuery(CONFIRM_QUERY)
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
    @Query('confirmDoNotStore', CONFIRM) confirm?: boolean,
  ) {
    const company = await this.records.company(companyId);
    return this.records.appendCsv(
      company,
      table,
      file?.buffer ?? Buffer.alloc(0),
      getCurrentUserId(req),
      confirm,
    );
  }

  /** Adds one record. */
  @ApiOperation({ summary: 'Add a record' })
  @ApiCreatedResponse({ type: TimedRecordDto })
  @ApiQuery(CONFIRM_QUERY)
  @CompanyScope(SCOPE)
  @Post('tables/:table/rows')
  async addRow(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Body() body: AddRecordDto,
    @Req() req: Request,
    @Query('confirmDoNotStore', CONFIRM) confirm?: boolean,
  ) {
    const company = await this.records.company(companyId);
    return this.records.addRow(
      company,
      table,
      body.data,
      getCurrentUserId(req),
      confirm,
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
  @ApiQuery(CONFIRM_QUERY)
  @CompanyScope(SCOPE)
  @Patch('tables/:table/rows/:id')
  async updateRow(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Param('id') id: string,
    @Body() body: UpdateRecordDto,
    @Req() req: Request,
    @Query('confirmDoNotStore', CONFIRM) confirm?: boolean,
  ) {
    const company = await this.records.company(companyId);
    return this.records.updateRow(
      company,
      table,
      id,
      body.changes,
      body.version,
      getCurrentUserId(req),
      confirm,
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

  /**
   * Rows in any table with a field containing `q`, in any case, grouped by
   * table: "everything about this person". A POST so the name searched for
   * stays out of URLs and access logs.
   */
  @ApiOperation({ summary: 'Search every record table' })
  @ApiOkResponse({ type: RecordSearchResultDto })
  @CompanyScope(SCOPE)
  @HttpCode(200)
  @Post('search')
  async search(
    @Param('companyId') companyId: string,
    @Body() body: SearchRecordsDto,
  ) {
    return this.records.search(await this.records.company(companyId), body.q);
  }

  /**
   * Chosen rows as a download: one table as CSV, several as a zip of CSVs.
   * For a subject access request, or any selection in the sheet.
   */
  @ApiOperation({ summary: 'Download chosen records' })
  @ApiProduces('text/csv', 'application/zip')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  @CompanyScope(SCOPE)
  @HttpCode(200)
  @Post('export')
  async exportSelection(
    @Param('companyId') companyId: string,
    @Body() body: ExportRecordsDto,
    @Res() res: Response,
  ): Promise<void> {
    const company = await this.records.company(companyId);
    const download = await this.records.exportSelection(company, body.tables);
    sendAttachment(
      res,
      download,
      download.filename.endsWith('.zip')
        ? 'application/zip'
        : 'text/csv; charset=utf-8',
    );
  }

  /** Deletes chosen records together. 409 when any has changed or gone. */
  @ApiOperation({ summary: 'Delete chosen records' })
  @ApiOkResponse({ type: RemovedRecordsDto })
  @CompanyScope(SCOPE)
  @HttpCode(200)
  @Post('tables/:table/rows/delete')
  async deleteRows(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Body() body: DeleteRecordsDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.deleteRows(
      company,
      table,
      body.rows,
      getCurrentUserId(req),
    );
  }

  /** Sets how long a table keeps its rows, or clears it with `null`. */
  @ApiOperation({ summary: "Set a record table's retention" })
  @ApiOkResponse({ type: RecordTableDefinitionDto })
  @CompanyScope(SCOPE)
  @Put('tables/:table/retention')
  async setRetention(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Body() body: SetRetentionDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.setRetention(
      company,
      table,
      body.retention ?? null,
      getCurrentUserId(req),
    );
  }

  /** Adds a column; every existing record gets the default, if one is given. */
  @ApiOperation({ summary: 'Add a column to a record table' })
  @ApiCreatedResponse({ type: RecordTableDefinitionDto })
  @ApiQuery(CONFIRM_QUERY)
  @CompanyScope(SCOPE)
  @Post('tables/:table/columns')
  async addColumn(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Body() body: AddColumnDto,
    @Req() req: Request,
    @Query('confirmDoNotStore', CONFIRM) confirm?: boolean,
  ) {
    const company = await this.records.company(companyId);
    return this.records.addColumn(
      company,
      table,
      body,
      getCurrentUserId(req),
      confirm,
    );
  }

  /** Renames a column in the table and in every record. */
  @ApiOperation({ summary: 'Rename a column of a record table' })
  @ApiOkResponse({ type: RecordTableDefinitionDto })
  @CompanyScope(SCOPE)
  @Patch('tables/:table/columns/:column')
  async renameColumn(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Param('column') column: string,
    @Body() body: RenameColumnDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.renameColumn(
      company,
      table,
      column,
      body.newName,
      getCurrentUserId(req),
    );
  }

  /** Deletes a column and its values. A key field must leave the key first. */
  @ApiOperation({ summary: 'Delete a column of a record table' })
  @ApiOkResponse({ type: RecordTableDefinitionDto })
  @CompanyScope(SCOPE)
  @Delete('tables/:table/columns/:column')
  async deleteColumn(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Param('column') column: string,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.deleteColumn(
      company,
      table,
      column,
      getCurrentUserId(req),
    );
  }

  /** Replaces the fields that identify a record. */
  @ApiOperation({ summary: "Set a record table's primary key" })
  @ApiOkResponse({ type: RecordTableDefinitionDto })
  @CompanyScope(SCOPE)
  @Put('tables/:table/primary-key')
  async setPrimaryKey(
    @Param('companyId') companyId: string,
    @Param('table') table: string,
    @Body() body: SetPrimaryKeyDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.setPrimaryKey(
      company,
      table,
      body.fields,
      getCurrentUserId(req),
    );
  }

  /** The company's do-not-store list. */
  @ApiOperation({ summary: 'List the do-not-store list' })
  @ApiOkResponse({ type: DoNotStoreEntryDto, isArray: true })
  @CompanyScope(SCOPE)
  @Get('do-not-store')
  async listDoNotStore(@Param('companyId') companyId: string) {
    return this.records.listDoNotStore(await this.records.company(companyId));
  }

  /** Adds an entry. 409 when it is already on the list. */
  @ApiOperation({ summary: 'Add to the do-not-store list' })
  @ApiCreatedResponse({ type: DoNotStoreEntryDto })
  @CompanyScope(SCOPE)
  @Post('do-not-store')
  async addDoNotStore(
    @Param('companyId') companyId: string,
    @Body() body: AddDoNotStoreDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.addDoNotStore(company, body, getCurrentUserId(req));
  }

  /** Changes an entry's text or note. */
  @ApiOperation({ summary: 'Change a do-not-store entry' })
  @ApiOkResponse({ type: DoNotStoreEntryDto })
  @CompanyScope(SCOPE)
  @Patch('do-not-store/:id')
  async updateDoNotStore(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Body() body: UpdateDoNotStoreDto,
    @Req() req: Request,
  ) {
    const company = await this.records.company(companyId);
    return this.records.updateDoNotStore(
      company,
      id,
      body,
      getCurrentUserId(req),
    );
  }

  /** Removes an entry. */
  @ApiOperation({ summary: 'Remove a do-not-store entry' })
  @ApiNoContentResponse()
  @CompanyScope(SCOPE)
  @HttpCode(204)
  @Delete('do-not-store/:id')
  async removeDoNotStore(
    @Param('companyId') companyId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    const company = await this.records.company(companyId);
    await this.records.removeDoNotStore(company, id, getCurrentUserId(req));
  }
}
