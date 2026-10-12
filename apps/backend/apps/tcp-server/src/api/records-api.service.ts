import {
  AuditEventType,
  type DoNotStoreEntry,
  type NewTable,
  type RecordData,
  RecordsError,
  RecordsService,
  type SearchResult,
  type TableDefinition,
  type TableRetention,
  type TableRows,
  type TableSummary,
  type TcpCompany,
  type TimedRecord,
  type VersionedRef,
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
    confirmDoNotStore = false,
  ): Promise<TimedRecord> {
    const overridden = await this.checkDoNotStore(
      company,
      [data],
      confirmDoNotStore,
    );
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
      ...overridden,
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
    confirmDoNotStore = false,
  ): Promise<TimedRecord> {
    const overridden = await this.checkDoNotStore(
      company,
      [changes],
      confirmDoNotStore,
    );
    const change = await call(() =>
      this.records.update(company.id, table, { id }, changes, version),
    );
    await this.changed(company, userId, {
      action: 'update',
      table,
      recordId: id,
      before: change.before,
      after: change.record.data,
      ...overridden,
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
    confirmDoNotStore = false,
  ): Promise<{ inserted: number; alreadyExists: number }> {
    const definition = await call(() =>
      this.records.describeTable(company.id, table),
    );
    const { rows, errors } = await call(() =>
      parseCsv(definition, file.toString('utf8')),
    );
    const overridden = errors.length
      ? {}
      : await this.checkDoNotStore(company, rows, confirmDoNotStore);
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
      ...overridden,
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

  /** Rows in any table with a field containing `q`, grouped by table. */
  search(company: TcpCompany, q: string): Promise<SearchResult> {
    return call(() => this.records.search(company.id, q));
  }

  /**
   * Chosen rows as a download: per table, the ids picked or `all`. One table
   * is a CSV; several are a zip with a CSV each, as for a subject access
   * request across tables.
   */
  async exportSelection(
    company: TcpCompany,
    tables: Record<string, string[] | 'all'>,
  ): Promise<RecordsDownload> {
    const names = Object.keys(tables);
    if (names.length === 0) {
      throw new BadRequestException('choose at least one table to export');
    }
    const files: Record<string, Uint8Array> = {};
    for (const name of names) {
      const ids = tables[name];
      if (
        ids !== 'all' &&
        !(Array.isArray(ids) && ids.every((id) => typeof id === 'string'))
      ) {
        throw new BadRequestException(
          `'${name}' must be 'all' or a list of record ids`,
        );
      }
      files[`${name}.csv`] = strToU8(
        ids === 'all'
          ? await this.csvText(company, name)
          : await this.selectionCsv(company, name, ids),
      );
    }
    if (names.length === 1) {
      return {
        filename: recordsDownloadName(company.slug, names[0], 'csv'),
        body: files[`${names[0]}.csv`],
      };
    }
    return {
      filename: recordsDownloadName(company.slug, 'tables', 'zip'),
      body: zipSync(files),
    };
  }

  /**
   * Deletes chosen records together, all or none. Audited by id only: the
   * audit log isn't erased with the records, so it mustn't keep their values.
   */
  async deleteRows(
    company: TcpCompany,
    table: string,
    rows: VersionedRef[],
    userId: string | null,
  ): Promise<{ removed: number }> {
    const removed = await call(() =>
      this.records.deleteRows(company.id, table, rows),
    );
    await this.changed(company, userId, {
      action: 'delete_rows',
      table,
      recordIds: rows.map((r) => r.id),
      removed,
    });
    return { removed };
  }

  /** Sets or clears how long a table keeps its rows. */
  async setRetention(
    company: TcpCompany,
    table: string,
    retention: TableRetention | null,
    userId: string | null,
  ): Promise<TableDefinition> {
    const definition = await call(() =>
      this.records.setRetention(company.id, table, retention),
    );
    await this.changed(company, userId, {
      action: 'set_retention',
      table,
      retention,
    });
    return definition;
  }

  listDoNotStore(company: TcpCompany): Promise<DoNotStoreEntry[]> {
    return call(() => this.records.listDoNotStore(company.id));
  }

  /** Adds a do-not-store entry. Audited by id, never by its text. */
  async addDoNotStore(
    company: TcpCompany,
    entry: { value: string; note?: string },
    userId: string | null,
  ): Promise<DoNotStoreEntry> {
    const added = await call(() =>
      this.records.addDoNotStore(company.id, entry, {
        role: 'user',
        id: userId,
      }),
    );
    await this.changed(company, userId, {
      action: 'do_not_store_add',
      entryId: added.id,
    });
    return added;
  }

  async updateDoNotStore(
    company: TcpCompany,
    id: string,
    changes: { value?: string; note?: string | null },
    userId: string | null,
  ): Promise<DoNotStoreEntry> {
    const updated = await call(() =>
      this.records.updateDoNotStore(company.id, id, changes),
    );
    await this.changed(company, userId, {
      action: 'do_not_store_update',
      entryId: id,
    });
    return updated;
  }

  async removeDoNotStore(
    company: TcpCompany,
    id: string,
    userId: string | null,
  ): Promise<void> {
    await call(() => this.records.removeDoNotStore(company.id, id));
    await this.changed(company, userId, {
      action: 'do_not_store_remove',
      entryId: id,
    });
  }

  /**
   * Warns before a person stores something on the do-not-store list: a 409
   * `do_not_store` naming the matching fields, unless they have confirmed.
   * A confirmed override is returned for the audit, by field name only.
   */
  private async checkDoNotStore(
    company: TcpCompany,
    rows: RecordData[],
    confirmed: boolean,
  ): Promise<{ doNotStoreOverride?: string[] }> {
    const fields = await call(() =>
      this.records.doNotStoreMatches(company.id, rows),
    );
    if (fields.length === 0) return {};
    if (!confirmed) {
      throw new ConflictException({
        message: `${fields.join(', ')} match the do-not-store list`,
        code: 'do_not_store',
        fields,
      });
    }
    return { doNotStoreOverride: fields };
  }

  /** Chosen rows of one table as CSV, oldest first. */
  private async selectionCsv(
    company: TcpCompany,
    table: string,
    ids: string[],
  ): Promise<string> {
    const definition = await call(() =>
      this.records.describeTable(company.id, table),
    );
    const rows = await call(() =>
      this.records.readRowsById(company.id, table, ids),
    );
    return (
      UTF8_BOM + toCsv(definition, [], true) + toCsv(definition, rows, false)
    );
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
