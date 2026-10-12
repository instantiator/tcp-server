import {
  AuditEventType,
  type NewTable,
  type RecordData,
  RecordsError,
  RecordsService,
  type TableDefinition,
  type TableRows,
  type TableSummary,
  type TcpCompany,
  type TimedRecord,
  recordsDownloadName,
} from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { strToU8, zipSync } from 'fflate';
import { AuditService } from '../audit/audit.service';
import { DbService } from '../db/db.service';
import { parseCsv, toCsv } from './records-csv';

/** What an export hands back: the file's name and bytes. */
export interface RecordsDownload {
  filename: string;
  body: Uint8Array;
}

/** Excel reads a UTF-8 CSV as its local code page unless it starts with a BOM. */
const UTF8_BOM = '\uFEFF';

/** The HTTP error a {@link RecordsError} becomes; anything else passes through. */
function httpError(e: unknown): unknown {
  if (!(e instanceof RecordsError)) return e;
  switch (e.code) {
    case 'not_found':
      return new NotFoundException(e.message);
    case 'conflict':
    case 'stale':
      return new ConflictException({ message: e.message, code: e.code });
    default:
      return new BadRequestException(e.message);
  }
}

/** Runs a records call, turning a correctable mistake into its HTTP error. */
async function call<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw httpError(e);
  }
}

/**
 * What the web UI and CLI do to a company's record tables (001.03): read,
 * correct, append CSV, clear, delete, and export. Company scoping is
 * {@link RecordsService}'s; membership is checked by the controller's guard
 * before any of this runs. Every change is audited as the person who made it.
 */
@Injectable()
export class RecordsApiService {
  constructor(
    private readonly records: RecordsService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** The company a route names, by id or slug. */
  async company(idOrSlug: string): Promise<TcpCompany> {
    const company = await this.db.getCompany(idOrSlug);
    if (!company) throw new NotFoundException(`Company not found: ${idOrSlug}`);
    return company;
  }

  listTables(company: TcpCompany): Promise<TableSummary[]> {
    return call(() => this.records.listTableSummaries(company.id));
  }

  /** Makes a table, as an agent's `create_table` does; audited as the user. */
  async createTable(
    company: TcpCompany,
    table: NewTable,
    userId: string | null,
  ): Promise<TableDefinition> {
    const definition = await call(() =>
      this.records.createTable(company.id, table, null),
    );
    await this.changed(company, userId, {
      action: 'create_table',
      table: definition.name,
      definition,
    });
    return definition;
  }

  readTable(company: TcpCompany, table: string): Promise<TableRows> {
    return call(() => this.records.readRows(company.id, table));
  }

  /** Adds one record; a record already holding its key is a 409 naming it. */
  async addRow(
    company: TcpCompany,
    table: string,
    data: RecordData,
    userId: string | null,
  ): Promise<TimedRecord> {
    const result = await call(() =>
      this.records.insert(company.id, table, data),
    );
    if (result.status === 'already_exists') {
      throw new ConflictException({
        message: `a record already has ${JSON.stringify(result.key)}`,
        code: 'conflict',
        recordId: result.record.id,
      });
    }
    await this.changed(company, userId, {
      action: 'add_row',
      table,
      recordId: result.record.id,
      after: result.record.data,
    });
    return call(() =>
      this.records.readRow(company.id, table, result.record.id),
    );
  }

  /** Changes a record, refusing it if the record moved on from `version`. */
  async updateRow(
    company: TcpCompany,
    table: string,
    id: string,
    changes: RecordData,
    version: number,
    userId: string | null,
  ): Promise<TimedRecord> {
    const change = await call(() =>
      this.records.update(company.id, table, { id }, changes, version),
    );
    await this.changed(company, userId, {
      action: 'update',
      table,
      recordId: id,
      before: change.before,
      after: change.record.data,
    });
    return call(() => this.records.readRow(company.id, table, id));
  }

  /** Deletes a record, keeping it if it moved on from `version`. */
  async deleteRow(
    company: TcpCompany,
    table: string,
    id: string,
    version: number,
    userId: string | null,
  ): Promise<void> {
    const change = await call(() =>
      this.records.delete(company.id, table, { id }, version),
    );
    await this.changed(company, userId, {
      action: 'delete_row',
      table,
      recordId: id,
      before: change.before,
    });
  }

  /**
   * Adds every row of an uploaded CSV, or none. A failing row is reported with
   * its spreadsheet row number (the header is row 1).
   */
  async appendCsv(
    company: TcpCompany,
    table: string,
    file: Buffer,
    userId: string | null,
  ): Promise<{ inserted: number; alreadyExists: number }> {
    const definition = await call(() =>
      this.records.describeTable(company.id, table),
    );
    const { rows, errors } = await call(() =>
      parseCsv(definition, file.toString('utf8')),
    );
    const result = errors.length
      ? { inserted: 0, alreadyExists: 0, errors }
      : await call(() => this.records.insertMany(company.id, table, rows));
    if (result.errors.length) {
      throw new BadRequestException({
        message: `${result.errors.length} row(s) can't be added, so none were`,
        // insertMany counts data rows from 1; the header is spreadsheet row 1.
        errors: errors.length
          ? errors
          : result.errors.map((e) => ({ ...e, row: e.row + 1 })),
      });
    }
    await this.changed(company, userId, {
      action: 'append_csv',
      table,
      inserted: result.inserted,
      alreadyExists: result.alreadyExists,
    });
    return { inserted: result.inserted, alreadyExists: result.alreadyExists };
  }

  /** Deletes every record of a table, keeping the table. */
  async clearTable(
    company: TcpCompany,
    table: string,
    userId: string | null,
  ): Promise<{ removed: number }> {
    const removed = await call(() =>
      this.records.clearTable(company.id, table),
    );
    await this.changed(company, userId, {
      action: 'clear_table',
      table,
      removed,
    });
    return { removed };
  }

  /** Deletes a table and its records; the audit keeps its definition. */
  async dropTable(
    company: TcpCompany,
    table: string,
    userId: string | null,
  ): Promise<{ removed: number }> {
    const { definition, removed } = await call(() =>
      this.records.dropTable(company.id, table),
    );
    await this.changed(company, userId, {
      action: 'drop_table',
      table,
      removed,
      definition,
    });
    return { removed };
  }

  /** One table as CSV: every record, oldest first. */
  async tableCsv(company: TcpCompany, table: string): Promise<RecordsDownload> {
    return {
      filename: recordsDownloadName(company.slug, table, 'csv'),
      body: strToU8(await this.csvText(company, table)),
    };
  }

  /**
   * Every table as one zip of CSVs.
   *
   * ponytail: built in memory (50 tables at most, each wholly read); stream
   * it with fflate's `Zip` class if exports grow past tens of megabytes.
   */
  async exportZip(company: TcpCompany): Promise<RecordsDownload> {
    const files: Record<string, Uint8Array> = {};
    for (const table of await this.listTables(company)) {
      files[`${table.name}.csv`] = strToU8(
        await this.csvText(company, table.name),
      );
    }
    return {
      filename: recordsDownloadName(company.slug, 'tables', 'zip'),
      body: zipSync(files),
    };
  }

  private async csvText(company: TcpCompany, table: string): Promise<string> {
    const definition = await call(() =>
      this.records.describeTable(company.id, table),
    );
    let text = UTF8_BOM + toCsv(definition, [], true);
    await call(() =>
      this.records.forEachRowBatch(company.id, table, (rows) => {
        text += toCsv(definition, rows, false);
      }),
    );
    return text;
  }

  /** Audits a change made by a person, not an agent. */
  private changed(
    company: TcpCompany,
    userId: string | null,
    detail: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      company.id,
      'user',
      null,
      AuditEventType.StateChange,
      { source: 'records', ...detail, userId },
    );
  }
}
