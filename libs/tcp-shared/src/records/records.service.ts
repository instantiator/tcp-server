import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import {
  DO_NOT_STORE_MAX_LENGTH,
  doNotStoreFields,
  normaliseDoNotStore,
} from './do-not-store';
import type { UUID } from '../uuid';
import { RecordSql } from './filter-sql';
import {
  AGGREGATE_OPS,
  type AlterOptions,
  type AlterResult,
  type AggregateQuery,
  type AggregateRow,
  type DoNotStoreEntry,
  type FieldSchema,
  type InsertManyResult,
  type InsertResult,
  type NewTable,
  type QueryResult,
  type RecordChange,
  type RecordData,
  type RecordQuery,
  type RecordRef,
  RecordsError,
  type RetentionSweep,
  type RowError,
  type SearchResult,
  type StoredRecord,
  type TableChange,
  type TableDefinition,
  type TableRetention,
  type TableRows,
  type TableSchema,
  type TableSummary,
  type TimedRecord,
  type VersionedRef,
} from './records.types';
import {
  RECORD_LIMITS,
  canonicalJson,
  checkAddColumn,
  checkDelete,
  checkDropUniqueKey,
  checkNewKey,
  checkNewUniqueKey,
  checkNewTable,
  checkRecord,
  checkRename,
  checkRetype,
  convertValue,
  keyName,
  keyValue,
  recordValidator,
} from './table-schema';

/** Postgres's unique-violation code: another row already holds the key. */
const UNIQUE_VIOLATION = '23505';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_OFFSET = 10_000;
const MAX_GROUP_BY = 3;
/** Rows a person's view of one table shows at most; the rest is in the export. */
const DEFAULT_ROW_CAP = 10_000;
/** Rows per batch when walking a whole table for export. */
const EXPORT_BATCH = 1000;
/** Tries at a batch insert that loses a race on a key before giving up. */
const INSERT_MANY_TRIES = 3;
/** Rows a search returns at most, across every table. */
const SEARCH_CAP = 1000;
/** The shortest search: anything shorter matches nearly every row. */
const SEARCH_MIN_LENGTH = 2;
/** Entries a company's do-not-store list holds at most. */
const DO_NOT_STORE_CAP = 1000;
/** The longest retention a table can have: a hundred years. */
const MAX_RETENTION_DAYS = 36_500;
/** A letter or digit in any script. */
const WORD_CHAR = /[\p{L}\p{N}]/u;

interface DoNotStoreRowSql {
  id: string;
  value: string;
  note: string | null;
  addedByRole: 'user' | 'agent';
  addedById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEntry(row: DoNotStoreRowSql): DoNotStoreEntry {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Checks an entry for the do-not-store list. It must hold a letter or digit,
 * and at least three characters: a shorter one, matched as a whole word,
 * would still block far more than the person it is about.
 */
function checkDoNotStoreValue(value: string): string {
  const normalised = normaliseDoNotStore(value);
  if (normalised.length < 3 || !WORD_CHAR.test(normalised)) {
    throw new RecordsError(
      'an entry needs at least three characters, including a letter or digit',
    );
  }
  if (normalised.length > DO_NOT_STORE_MAX_LENGTH) {
    throw new RecordsError(
      `an entry can be at most ${DO_NOT_STORE_MAX_LENGTH} characters`,
    );
  }
  return normalised;
}

/** Whether `field` is a text field holding a date: what can start a retention clock. */
function isDateField(schema: TableSchema, field: string): boolean {
  const property = schema.properties[field];
  return (
    property?.type === 'string' &&
    (property.format === 'date' || property.format === 'date-time')
  );
}

/** A column type in words, for a message about converting to it. */
function typeWords(field: FieldSchema): string {
  if (field.format === 'date') return 'a date';
  return {
    string: 'text',
    number: 'a number',
    integer: 'a whole number',
    boolean: 'true or false',
  }[field.type];
}

/** A LIKE pattern finding `text` anywhere, with `%`, `_` and `\` taken literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

interface TableRow extends TableDefinition {
  companyId: string;
}

interface RecordRowSql {
  id: string;
  data: RecordData;
  version: number;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof QueryFailedError &&
    (e.driverError as { code?: string }).code === UNIQUE_VIOLATION
  );
}

interface TimedRowSql extends RecordRowSql {
  createdAt: Date;
  updatedAt: Date;
}

function toStored(row: RecordRowSql): StoredRecord {
  return { id: row.id, data: row.data, version: row.version };
}

/** A table row without its company, as callers see it. */
function definitionOf(table: TableRow): TableDefinition {
  return {
    id: table.id,
    name: table.name,
    purpose: table.purpose,
    schema: table.schema,
    primaryKey: table.primaryKey,
    uniqueKeys: table.uniqueKeys,
    retention: table.retention ?? null,
  };
}

function toTimed(row: TimedRowSql): TimedRecord {
  return {
    ...toStored(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Throws a `stale` error when the caller's version isn't the record's current one. */
function checkVersion(
  current: StoredRecord,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new RecordsError(
      `the record has changed since version ${expectedVersion} (it is now version ${current.version})`,
      'stale',
    );
  }
}

/**
 * Typed, per-company record tables stored as JSONB.
 *
 * Every statement filters on `companyId`, which is the access boundary: an
 * agent can reach any table of its own company and nothing of another's.
 * Primary and unique keys are enforced by `record_key`'s primary key inside
 * the same transaction as the record, so a repeated insert — a retried job, a
 * restarted agent — finds the existing record instead of creating a second.
 *
 * It returns the before/after values a caller needs for the audit trail but
 * audits nothing itself, so the MCP server can audit as the agent and the web
 * UI (001.03) as the user.
 */
@Injectable()
export class RecordsService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  /** Names and purposes of the company's tables, alphabetically. */
  async listTables(
    companyId: string,
  ): Promise<{ name: string; purpose: string }[]> {
    return await this.ds.query<{ name: string; purpose: string }[]>(
      `SELECT "name", "purpose" FROM "record_table" WHERE "companyId" = $1 ORDER BY "name"`,
      [companyId],
    );
  }

  /** One table's full definition. */
  async describeTable(
    companyId: string,
    name: string,
  ): Promise<TableDefinition> {
    return definitionOf(await this.table(this.ds.manager, companyId, name));
  }

  /** Creates a table after checking its definition (see {@link checkNewTable}). */
  async createTable(
    companyId: string,
    table: NewTable,
    agentId: string | null,
  ): Promise<TableDefinition> {
    const { schema, primaryKey, uniqueKeys } = checkNewTable(table);
    const [{ count }] = await this.ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "record_table" WHERE "companyId" = $1`,
      [companyId],
    );
    if (count >= RECORD_LIMITS.tablesPerCompany) {
      throw new RecordsError(
        `the company already has ${RECORD_LIMITS.tablesPerCompany} tables, the most allowed`,
      );
    }
    try {
      const [{ id }] = await this.ds.query<{ id: string }[]>(
        `INSERT INTO "record_table" ("companyId", "name", "purpose", "schema", "primaryKey", "uniqueKeys", "createdByAgentId")
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING "id"`,
        [
          companyId,
          table.name,
          table.purpose.trim(),
          JSON.stringify(schema),
          JSON.stringify(primaryKey),
          JSON.stringify(uniqueKeys),
          agentId,
        ],
      );
      return {
        id,
        name: table.name,
        purpose: table.purpose.trim(),
        schema,
        primaryKey,
        uniqueKeys,
        retention: null,
      };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new RecordsError(
          `a table named '${table.name}' already exists — use describe_table to see it`,
          'conflict',
        );
      }
      throw e;
    }
  }

  /**
   * Inserts a record, or returns the one already holding its primary or a
   * unique key. Never creates a duplicate: when two inserts race, the
   * `record_key` primary key lets exactly one commit, and the other is
   * answered with the winner. The table's definition is read under a share
   * lock, so a column change can't land between the check and the write.
   */
  async insert(
    companyId: string,
    tableName: string,
    data: RecordData,
  ): Promise<InsertResult> {
    try {
      return await this.ds.transaction(async (tx) => {
        const table = await this.table(tx, companyId, tableName, 'share');
        checkRecord(recordValidator(table.schema), data);
        const existing = await this.findByKeys(tx, table, data);
        if (existing) return existing;
        const [row] = await tx.query<RecordRowSql[]>(
          `INSERT INTO "record" ("tableId", "companyId", "data") VALUES ($1, $2, $3)
           RETURNING "id", "data", "version"`,
          [table.id, companyId, JSON.stringify(data)],
        );
        await this.writeKeys(tx, table, row.id, data);
        return { status: 'inserted' as const, record: toStored(row) };
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Lost a race to a concurrent insert of the same key: answer with the winner.
      const table = await this.table(this.ds.manager, companyId, tableName);
      const winner = await this.findByKeys(this.ds.manager, table, data);
      if (winner) return winner;
      throw e;
    }
  }

  /**
   * Merges `changes` into a record (`null` removes a field), re-checks it
   * against the schema and rewrites its keys. The row is locked for the
   * duration, so two concurrent updates apply one after the other. With
   * `expectedVersion`, a record changed since the caller read it is refused.
   */
  async update(
    companyId: string,
    tableName: string,
    ref: RecordRef,
    changes: RecordData,
    expectedVersion?: number,
  ): Promise<RecordChange> {
    try {
      return await this.ds.transaction(async (tx) => {
        const table = await this.table(tx, companyId, tableName, 'share');
        const validate = recordValidator(table.schema);
        const current = await this.resolve(tx, table, ref, true);
        checkVersion(current, expectedVersion);
        const merged: RecordData = { ...current.data };
        for (const [field, value] of Object.entries(changes)) {
          if (value === null) delete merged[field];
          else merged[field] = value;
        }
        checkRecord(validate, merged);
        await tx.query(`DELETE FROM "record_key" WHERE "recordId" = $1`, [
          current.id,
        ]);
        await this.writeKeys(tx, table, current.id, merged);
        // TypeORM answers an UPDATE with [rows, affectedCount].
        const [rows] = await tx.query<[RecordRowSql[], number]>(
          `UPDATE "record" SET "data" = $1, "version" = "version" + 1, "updatedAt" = now()
           WHERE "id" = $2 RETURNING "id", "data", "version"`,
          [JSON.stringify(merged), current.id],
        );
        return { record: toStored(rows[0]), before: current.data };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new RecordsError(
          'another record already has that key value — query for it, or choose a different value',
          'conflict',
        );
      }
      throw e;
    }
  }

  /**
   * Deletes a record; the returned `before` is all that remains of it. With
   * `expectedVersion`, a record changed since the caller read it is kept.
   */
  async delete(
    companyId: string,
    tableName: string,
    ref: RecordRef,
    expectedVersion?: number,
  ): Promise<RecordChange> {
    return this.ds.transaction(async (tx) => {
      // A ref by key is looked up by the key's stored name, which a column change rewrites.
      const table = await this.table(tx, companyId, tableName, 'share');
      const current = await this.resolve(tx, table, ref, true);
      checkVersion(current, expectedVersion);
      await tx.query(`DELETE FROM "record" WHERE "id" = $1`, [current.id]);
      return { record: current, before: current.data };
    });
  }

  /** A page of matching records, newest first unless `sort` says otherwise. */
  async query(
    companyId: string,
    tableName: string,
    query: RecordQuery,
  ): Promise<QueryResult> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new RecordsError(
        `limit must be a whole number from 1 to ${MAX_LIMIT}`,
      );
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
      throw new RecordsError(
        `offset must be a whole number from 0 to ${MAX_OFFSET}`,
      );
    }
    const sql = new RecordSql(table.schema);
    const tableParam = sql.bind(table.id);
    const companyParam = sql.bind(companyId);
    const where = sql.where(query.filters);
    const order = (query.sort ?? [])
      .map(
        (s) =>
          `${sql.expr(s.field)} ${s.direction === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`,
      )
      .concat(`r."createdAt" DESC`, `r."id"`)
      .join(', ');
    const rows = await this.ds.query<(RecordRowSql & { total: number })[]>(
      `SELECT r."id", r."data", r."version", count(*) OVER ()::int AS total
       FROM "record" r
       WHERE r."tableId" = ${tableParam} AND r."companyId" = ${companyParam} AND ${where}
       ORDER BY ${order}
       LIMIT ${sql.bind(limit)} OFFSET ${sql.bind(offset)}`,
      sql.params,
    );
    return {
      records: rows.map(toStored),
      total:
        rows[0]?.total ?? (offset > 0 ? await this.count(table, query) : 0),
    };
  }

  /**
   * Counts, totals, averages or extremes over matching records, optionally
   * grouped. Computed in Postgres `numeric` and returned as decimal strings,
   * so a month's income adds up exactly.
   */
  async aggregate(
    companyId: string,
    tableName: string,
    query: AggregateQuery,
  ): Promise<AggregateRow[]> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    if (!AGGREGATE_OPS.includes(query.op)) {
      throw new RecordsError(
        `unknown aggregate '${String(query.op)}' — use one of ${AGGREGATE_OPS.join(', ')}`,
      );
    }
    const groupBy = query.groupBy ?? [];
    if (groupBy.length > MAX_GROUP_BY) {
      throw new RecordsError(`group_by takes at most ${MAX_GROUP_BY} fields`);
    }
    const sql = new RecordSql(table.schema);
    const groupColumns = groupBy.map((f, i) => `${sql.jsonExpr(f)} AS g${i}`);
    const value = this.aggregateExpr(sql, query);
    const tableParam = sql.bind(table.id);
    const companyParam = sql.bind(companyId);
    const where = sql.where(query.filters);
    // Ordinals, not repeated expressions: each bound field name is a fresh
    // parameter, and Postgres wouldn't see two of them as the same grouping.
    const ordinals = groupBy.map((_, i) => String(i + 1)).join(', ');
    const rows = await this.ds.query<Record<string, unknown>[]>(
      `SELECT ${[...groupColumns, `(${value})::text AS value`].join(', ')}
       FROM "record" r
       WHERE r."tableId" = ${tableParam} AND r."companyId" = ${companyParam} AND ${where}
       ${groupBy.length ? `GROUP BY ${ordinals} ORDER BY ${ordinals}` : ''}
       LIMIT ${MAX_LIMIT}`,
      sql.params,
    );
    return rows.map((row) => ({
      group: Object.fromEntries(groupBy.map((f, i) => [f, row[`g${i}`]])),
      value: row['value'] as string | null,
    }));
  }

  /**
   * Deletes every table (and so every record) of a company, and its
   * do-not-store list. Returns how many tables went.
   */
  async deleteCompany(companyId: string): Promise<number> {
    // TypeORM answers a DELETE with [rows, affectedCount].
    const [, count] = await this.ds.query<[unknown, number]>(
      `DELETE FROM "record_table" WHERE "companyId" = $1`,
      [companyId],
    );
    await this.ds.query(
      `DELETE FROM "record_do_not_store" WHERE "companyId" = $1`,
      [companyId],
    );
    return count;
  }

  /** The company's tables with their record counts, alphabetically. */
  async listTableSummaries(companyId: string): Promise<TableSummary[]> {
    const rows = await this.ds.query<
      { name: string; purpose: string; records: number; updatedAt: Date }[]
    >(
      `SELECT t."name", t."purpose", count(r."id")::int AS "records",
              greatest(t."updatedAt", max(r."updatedAt")) AS "updatedAt"
       FROM "record_table" t LEFT JOIN "record" r ON r."tableId" = t."id"
       WHERE t."companyId" = $1
       GROUP BY t."id" ORDER BY t."name"`,
      [companyId],
    );
    return rows.map((row) => ({
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /**
   * A table's definition and its rows, most recently changed first, for a
   * person to read and edit. At most `cap` rows; `truncated` says there were more.
   */
  async readRows(
    companyId: string,
    tableName: string,
    cap = DEFAULT_ROW_CAP,
  ): Promise<TableRows> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    const rows = await this.ds.query<(TimedRowSql & { total: number })[]>(
      `SELECT "id", "data", "version", "createdAt", "updatedAt", count(*) OVER ()::int AS total
       FROM "record" WHERE "tableId" = $1 AND "companyId" = $2
       ORDER BY "updatedAt" DESC, "id" LIMIT $3`,
      [table.id, companyId, cap],
    );
    const total = rows[0]?.total ?? 0;
    return {
      definition: definitionOf(table),
      rows: rows.map(toTimed),
      total,
      truncated: total > rows.length,
    };
  }

  /** One record with its timestamps, e.g. to show a change just made. */
  async readRow(
    companyId: string,
    tableName: string,
    id: string,
  ): Promise<TimedRecord> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    const [row] = await this.ds.query<TimedRowSql[]>(
      `SELECT "id", "data", "version", "createdAt", "updatedAt" FROM "record"
       WHERE "id"::text = $1 AND "tableId" = $2 AND "companyId" = $3`,
      [id, table.id, companyId],
    );
    if (!row) {
      throw new RecordsError(`no record ${id} in '${tableName}'`, 'not_found');
    }
    return toTimed(row);
  }

  /**
   * Walks every record of a table, oldest first, in batches, for an export with
   * no row cap. The cursor is the last row's id, so no row is repeated or
   * skipped even when two share a creation time.
   */
  async forEachRowBatch(
    companyId: string,
    tableName: string,
    onBatch: (rows: RecordData[]) => void | Promise<void>,
  ): Promise<void> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    let after: string | null = null;
    for (;;) {
      const rows: { id: string; data: RecordData }[] = await this.ds.query(
        `SELECT r."id", r."data" FROM "record" r
         WHERE r."tableId" = $1 AND r."companyId" = $2
           AND ($3::uuid IS NULL OR (r."createdAt", r."id") >
               (SELECT c."createdAt", c."id" FROM "record" c WHERE c."id" = $3::uuid))
         ORDER BY r."createdAt", r."id" LIMIT $4`,
        [table.id, companyId, after, EXPORT_BATCH],
      );
      if (!rows.length) return;
      await onBatch(rows.map((r) => r.data));
      if (rows.length < EXPORT_BATCH) return;
      after = rows[rows.length - 1].id;
    }
  }

  /**
   * Inserts many records at once, all or nothing. Every row is checked first;
   * if any fails its schema, nothing is inserted and every failure is listed.
   * A row whose key is already held (by an existing record or an earlier row
   * of the batch) is counted, not inserted, just as {@link insert} answers it.
   */
  async insertMany(
    companyId: string,
    tableName: string,
    rows: RecordData[],
  ): Promise<InsertManyResult> {
    if (rows.length > RECORD_LIMITS.rowsPerInsert) {
      throw new RecordsError(
        `at most ${RECORD_LIMITS.rowsPerInsert} records can be added at once; this has ${rows.length}`,
      );
    }
    // ponytail: a few queries per row in one transaction; fine for the
    // 10,000-row cap, switch to a COPY into a staging table if appends get slow.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.ds.transaction(async (tx) => {
          const table = await this.table(tx, companyId, tableName, 'share');
          const validate = recordValidator(table.schema);
          const errors: RowError[] = [];
          rows.forEach((data, i) => {
            try {
              checkRecord(validate, data);
            } catch (e) {
              if (!(e instanceof RecordsError)) throw e;
              errors.push({ row: i + 1, message: e.message });
            }
          });
          if (errors.length) return { inserted: 0, alreadyExists: 0, errors };
          let inserted = 0;
          for (const [index, data] of rows.entries()) {
            if (await this.findByKeys(tx, table, data)) continue;
            // The transaction's time plus the row's index in microseconds,
            // not the default now() alone (shared by the whole transaction)
            // nor clock_timestamp() (too coarse in some VMs): rows keep the
            // file's order in an export, whatever the clock does.
            const [row] = await tx.query<{ id: string }[]>(
              `INSERT INTO "record" ("tableId", "companyId", "data", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, now() + $4 * interval '1 microsecond', now() + $4 * interval '1 microsecond')
               RETURNING "id"`,
              [table.id, companyId, JSON.stringify(data), index],
            );
            await this.writeKeys(tx, table, row.id, data);
            inserted++;
          }
          return {
            inserted,
            alreadyExists: rows.length - inserted,
            errors: [],
          };
        });
      } catch (e) {
        // A concurrent insert took one of our keys: start again, and this
        // time that row is found and counted as already there.
        if (!isUniqueViolation(e) || attempt === INSERT_MANY_TRIES) throw e;
      }
    }
  }

  /** Deletes every record of a table, keeping the table. Returns how many went. */
  async clearTable(companyId: string, tableName: string): Promise<number> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    // TypeORM answers a DELETE with [rows, affectedCount].
    const [, count] = await this.ds.query<[unknown, number]>(
      `DELETE FROM "record" WHERE "tableId" = $1 AND "companyId" = $2`,
      [table.id, companyId],
    );
    return count;
  }

  /**
   * Deletes a table and its records. Returns the definition it had and how many
   * records went, for the audit trail.
   */
  async dropTable(
    companyId: string,
    tableName: string,
  ): Promise<{ definition: TableDefinition; removed: number }> {
    return this.ds.transaction(async (tx) => {
      const table = await this.table(tx, companyId, tableName);
      const [{ removed }] = await tx.query<{ removed: number }[]>(
        `SELECT count(*)::int AS removed FROM "record" WHERE "tableId" = $1`,
        [table.id],
      );
      await tx.query(
        `DELETE FROM "record_table" WHERE "id" = $1 AND "companyId" = $2`,
        [table.id, companyId],
      );
      return { definition: definitionOf(table), removed };
    });
  }

  /**
   * Changes a table's columns or primary key, and rewrites its records to
   * match, in one transaction. The table is locked first, so writes in flight
   * finish before it and new ones wait for it: no record is ever stored under
   * a column name that has just gone. A rewritten record's version goes up,
   * so a stale edit of it is refused, but its `updatedAt` stays: this is not
   * an edit of its data, and retention mustn't restart.
   *
   * With `byPerson` false, a key can only gain fields (see {@link checkNewKey}).
   */
  async alterTable(
    companyId: string,
    tableName: string,
    change: TableChange,
    opts: AlterOptions,
  ): Promise<AlterResult> {
    return this.ds.transaction(async (tx) => {
      const table = await this.table(tx, companyId, tableName, 'update');
      const before = definitionOf(table);
      const after = structuredClone(before);
      let rewritten = 0;
      let blanked = 0;
      switch (change.op) {
        case 'add_column': {
          const [{ records, largest }] = await tx.query<
            { records: number; largest: number }[]
          >(
            `SELECT count(*)::int AS "records", coalesce(max(octet_length("data"::text)), 0)::int AS "largest"
             FROM "record" WHERE "tableId" = $1`,
            [table.id],
          );
          after.schema.properties[change.column] = checkAddColumn(
            before,
            change,
            records,
          );
          if (change.required) {
            after.schema.required = [
              ...(after.schema.required ?? []),
              change.column,
            ];
          }
          if (change.default !== undefined && records > 0) {
            const added = JSON.stringify({ [change.column]: change.default });
            if (
              largest + Buffer.byteLength(added) >
              RECORD_LIMITS.recordBytes
            ) {
              throw new RecordsError(
                `that default would make a record larger than ${RECORD_LIMITS.recordBytes / 1024} KB; use a shorter one`,
              );
            }
            rewritten = await this.rewriteRows(
              tx,
              `"data" || jsonb_build_object($2::text, $3::jsonb)`,
              [table.id, change.column, JSON.stringify(change.default)],
            );
          }
          break;
        }
        case 'rename_column': {
          const { column, newName } = change;
          checkRename(before, column, newName);
          const rename = (f: string): string => (f === column ? newName : f);
          after.schema.properties = Object.fromEntries(
            Object.entries(before.schema.properties).map(([f, s]) => [
              rename(f),
              s,
            ]),
          );
          if (before.schema.required) {
            after.schema.required = before.schema.required.map(rename);
          }
          after.primaryKey = before.primaryKey.map(rename);
          after.uniqueKeys = before.uniqueKeys.map((key) => key.map(rename));
          if (before.retention) {
            after.retention = {
              ...before.retention,
              from: rename(before.retention.from),
            };
          }
          // A key's stored value holds only values, so only its name changes.
          for (const key of [before.primaryKey, ...before.uniqueKeys]) {
            if (!key.includes(column)) continue;
            await tx.query(
              `UPDATE "record_key" SET "keyName" = $3 WHERE "tableId" = $1 AND "keyName" = $2`,
              [table.id, keyName(key), keyName(key.map(rename))],
            );
          }
          rewritten = await this.rewriteRows(
            tx,
            `("data" - $2::text) || jsonb_build_object($3::text, "data" -> $2::text)`,
            [table.id, column, newName],
            `jsonb_exists("data", $2::text)`,
          );
          break;
        }
        case 'delete_column': {
          checkDelete(before, change.column);
          delete after.schema.properties[change.column];
          if (before.schema.required) {
            after.schema.required = before.schema.required.filter(
              (f) => f !== change.column,
            );
          }
          rewritten = await this.rewriteRows(
            tx,
            `"data" - $2::text`,
            [table.id, change.column],
            `jsonb_exists("data", $2::text)`,
          );
          break;
        }
        case 'set_primary_key': {
          const key = checkNewKey(before, change.fields, opts.byPerson);
          await this.rebuildKey(tx, table, before.primaryKey, key);
          after.primaryKey = key;
          after.schema.required = [
            ...new Set([...(before.schema.required ?? []), ...key]),
          ];
          break;
        }
        case 'add_unique_key': {
          const key = checkNewUniqueKey(before, change.fields, opts.byPerson);
          await this.rebuildKey(tx, table, null, key);
          after.uniqueKeys = [...before.uniqueKeys, key];
          after.schema.required = [
            ...new Set([...(before.schema.required ?? []), ...key]),
          ];
          break;
        }
        case 'drop_unique_key': {
          const key = keyName(
            checkDropUniqueKey(before, change.fields, opts.byPerson),
          );
          await tx.query(
            `DELETE FROM "record_key" WHERE "tableId" = $1 AND "keyName" = $2`,
            [table.id, key],
          );
          after.uniqueKeys = before.uniqueKeys.filter(
            (fields) => keyName(fields) !== key,
          );
          break;
        }
        case 'retype_column': {
          const field = checkRetype(before, change);
          ({ rewritten, blanked } = await this.retype(
            tx,
            table,
            change.column,
            field,
            opts,
          ));
          after.schema.properties[change.column] = field;
          break;
        }
      }
      await tx.query(
        `UPDATE "record_table" SET "schema" = $2, "primaryKey" = $3, "uniqueKeys" = $4, "retention" = $5, "updatedAt" = now()
         WHERE "id" = $1`,
        [
          table.id,
          JSON.stringify(after.schema),
          JSON.stringify(after.primaryKey),
          JSON.stringify(after.uniqueKeys),
          after.retention ? JSON.stringify(after.retention) : null,
        ],
      );
      return { definition: after, before, rewritten, blanked };
    });
  }

  /** The company's do-not-store list, alphabetically. */
  async listDoNotStore(companyId: string): Promise<DoNotStoreEntry[]> {
    const rows = await this.ds.query<DoNotStoreRowSql[]>(
      `SELECT "id", "value", "note", "addedByRole", "addedById", "createdAt", "updatedAt"
       FROM "record_do_not_store" WHERE "companyId" = $1 ORDER BY "normalised"`,
      [companyId],
    );
    return rows.map(toEntry);
  }

  /**
   * Adds an entry to the do-not-store list. An entry already there (in any
   * case or spacing) is a `conflict`.
   */
  async addDoNotStore(
    companyId: string,
    entry: { value: string; note?: string | null },
    addedBy: { role: 'user' | 'agent'; id: string | null },
  ): Promise<DoNotStoreEntry> {
    const normalised = checkDoNotStoreValue(entry.value);
    const [{ count }] = await this.ds.query<{ count: number }[]>(
      `SELECT count(*)::int AS count FROM "record_do_not_store" WHERE "companyId" = $1`,
      [companyId],
    );
    if (count >= DO_NOT_STORE_CAP) {
      throw new RecordsError(
        `the do-not-store list already has ${DO_NOT_STORE_CAP} entries, the most allowed`,
      );
    }
    try {
      const [row] = await this.ds.query<DoNotStoreRowSql[]>(
        `INSERT INTO "record_do_not_store" ("companyId", "value", "normalised", "note", "addedByRole", "addedById")
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING "id", "value", "note", "addedByRole", "addedById", "createdAt", "updatedAt"`,
        [
          companyId,
          entry.value.trim(),
          normalised,
          entry.note?.trim() || null,
          addedBy.role,
          addedBy.id,
        ],
      );
      return toEntry(row);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new RecordsError(
          'that entry is already on the do-not-store list',
          'conflict',
        );
      }
      throw e;
    }
  }

  /** Changes an entry's text or note. */
  async updateDoNotStore(
    companyId: string,
    id: string,
    changes: { value?: string; note?: string | null },
  ): Promise<DoNotStoreEntry> {
    const value = changes.value?.trim();
    const normalised =
      value !== undefined ? checkDoNotStoreValue(value) : undefined;
    try {
      // TypeORM answers an UPDATE with [rows, affectedCount].
      const [rows] = await this.ds.query<[DoNotStoreRowSql[], number]>(
        `UPDATE "record_do_not_store"
         SET "value" = coalesce($3, "value"), "normalised" = coalesce($4, "normalised"),
             "note" = CASE WHEN $5 THEN $6 ELSE "note" END, "updatedAt" = now()
         WHERE "id"::text = $1 AND "companyId" = $2
         RETURNING "id", "value", "note", "addedByRole", "addedById", "createdAt", "updatedAt"`,
        [
          id,
          companyId,
          value ?? null,
          normalised ?? null,
          changes.note !== undefined,
          changes.note?.trim() || null,
        ],
      );
      if (!rows[0]) {
        throw new RecordsError(
          'no such entry on the do-not-store list',
          'not_found',
        );
      }
      return toEntry(rows[0]);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new RecordsError(
          'that entry is already on the do-not-store list',
          'conflict',
        );
      }
      throw e;
    }
  }

  /** Removes an entry from the do-not-store list. */
  async removeDoNotStore(companyId: string, id: string): Promise<void> {
    // TypeORM answers a DELETE with [rows, affectedCount].
    const [, count] = await this.ds.query<[unknown, number]>(
      `DELETE FROM "record_do_not_store" WHERE "id"::text = $1 AND "companyId" = $2`,
      [id, companyId],
    );
    if (count === 0) {
      throw new RecordsError(
        'no such entry on the do-not-store list',
        'not_found',
      );
    }
  }

  /**
   * The fields, across `rows`, that hold an entry of the company's
   * do-not-store list as a whole phrase in any case; empty when they may all
   * be stored. The list is read once, however many rows there are.
   */
  // ponytail: checked before the write, outside its transaction, so an entry
  // added in that instant can miss one write. Lock the list if that matters.
  async doNotStoreMatches(
    companyId: string,
    rows: RecordData[],
  ): Promise<string[]> {
    const entries = (
      await this.ds.query<{ normalised: string }[]>(
        `SELECT "normalised" FROM "record_do_not_store" WHERE "companyId" = $1`,
        [companyId],
      )
    ).map((r) => r.normalised);
    return [...new Set(rows.flatMap((row) => doNotStoreFields(row, entries)))];
  }

  /**
   * Rows in any of the company's tables with a field containing `text`, in
   * any case, grouped by table. Broader than the do-not-store match on
   * purpose: finding should catch near misses, blocking should not.
   */
  async search(companyId: string, text: string): Promise<SearchResult> {
    const q = text.trim();
    if (q.length < SEARCH_MIN_LENGTH) {
      throw new RecordsError(
        `search for at least ${SEARCH_MIN_LENGTH} characters`,
      );
    }
    const rows = await this.ds.query<(TimedRowSql & { tableId: string })[]>(
      `SELECT r."id", r."data", r."version", r."createdAt", r."updatedAt", r."tableId"
       FROM "record" r
       WHERE r."companyId" = $1
         AND EXISTS (SELECT 1 FROM jsonb_each_text(r."data") f WHERE f."value" ILIKE $2)
       ORDER BY r."tableId", r."updatedAt" DESC, r."id"
       LIMIT $3`,
      [companyId, likePattern(q), SEARCH_CAP + 1],
    );
    const truncated = rows.length > SEARCH_CAP;
    const found = rows.slice(0, SEARCH_CAP);
    const tables = await this.ds.query<TableRow[]>(
      `SELECT "id", "companyId", "name", "purpose", "schema", "primaryKey", "uniqueKeys", "retention"
       FROM "record_table" WHERE "companyId" = $1 AND "id" = ANY($2::uuid[])
       ORDER BY "name"`,
      [companyId, [...new Set(found.map((r) => r.tableId))]],
    );
    return {
      groups: tables.map((table) => ({
        definition: definitionOf(table),
        rows: found.filter((r) => r.tableId === table.id).map(toTimed),
      })),
      truncated,
    };
  }

  /** Chosen records of one table, oldest first, for an export of a selection. */
  async readRowsById(
    companyId: string,
    tableName: string,
    ids: string[],
  ): Promise<RecordData[]> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    const rows = await this.ds.query<{ data: RecordData }[]>(
      `SELECT "data" FROM "record"
       WHERE "tableId" = $1 AND "companyId" = $2 AND "id"::text = ANY($3::text[])
       ORDER BY "createdAt", "id"`,
      [table.id, companyId, ids],
    );
    return rows.map((r) => r.data);
  }

  /**
   * Deletes chosen records of one table, all or none: if any has gone or
   * changed since the caller saw it, nothing is deleted. Returns how many went.
   */
  async deleteRows(
    companyId: string,
    tableName: string,
    refs: VersionedRef[],
  ): Promise<number> {
    if (refs.length > RECORD_LIMITS.rowsPerInsert) {
      throw new RecordsError(
        `at most ${RECORD_LIMITS.rowsPerInsert} records can be deleted at once; this has ${refs.length}`,
      );
    }
    const table = await this.table(this.ds.manager, companyId, tableName);
    return this.ds.transaction(async (tx) => {
      const ids = refs.map((r) => r.id);
      const current = await tx.query<{ id: string; version: number }[]>(
        `SELECT "id"::text AS "id", "version" FROM "record"
         WHERE "tableId" = $1 AND "companyId" = $2 AND "id"::text = ANY($3::text[])
         FOR UPDATE`,
        [table.id, companyId, ids],
      );
      const versions = new Map(current.map((r) => [r.id, r.version]));
      for (const ref of refs) {
        const version = versions.get(ref.id);
        if (version === undefined) {
          throw new RecordsError(
            `record ${ref.id} is no longer in '${tableName}'`,
            'stale',
          );
        }
        checkVersion({ id: ref.id, data: {}, version }, ref.version);
      }
      // TypeORM answers a DELETE with [rows, affectedCount].
      const [, count] = await tx.query<[unknown, number]>(
        `DELETE FROM "record" WHERE "tableId" = $1 AND "id"::text = ANY($2::text[])`,
        [table.id, ids],
      );
      return count;
    });
  }

  /**
   * Sets how long a table keeps its rows, or clears it with `null`. `from`
   * must be `updated` or one of the table's date fields.
   */
  async setRetention(
    companyId: string,
    tableName: string,
    retention: TableRetention | null,
  ): Promise<TableDefinition> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    if (retention) {
      const { days, from } = retention;
      if (!Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS) {
        throw new RecordsError(
          `keep rows for a whole number of days, from 1 to ${MAX_RETENTION_DAYS}`,
        );
      }
      if (from !== 'updated' && !isDateField(table.schema, from)) {
        throw new RecordsError(
          `rows can be kept from their last update, or from a date field; '${from}' is neither`,
        );
      }
    }
    await this.ds.query(
      `UPDATE "record_table" SET "retention" = $1, "updatedAt" = now() WHERE "id" = $2`,
      [retention ? JSON.stringify(retention) : null, table.id],
    );
    return definitionOf({ ...table, retention });
  }

  /**
   * Deletes every row past its table's retention, across every company.
   * A row whose date field is blank, or not a date, is kept. A table that
   * fails is reported through `onError` and skipped, so one bad table can't
   * stop the others.
   */
  async sweepRetention(
    now: Date,
    onError: (table: string, err: unknown) => void,
  ): Promise<RetentionSweep[]> {
    const tables = await this.ds.query<
      {
        id: string;
        companyId: UUID;
        name: string;
        retention: TableRetention;
      }[]
    >(
      `SELECT "id", "companyId", "name", "retention" FROM "record_table"
       WHERE "retention" IS NOT NULL`,
    );
    const swept: RetentionSweep[] = [];
    for (const table of tables) {
      const { days, from } = table.retention;
      try {
        // TypeORM answers a DELETE with [rows, affectedCount].
        const [, deleted] =
          from === 'updated'
            ? await this.ds.query<[unknown, number]>(
                `DELETE FROM "record" WHERE "tableId" = $1
                 AND "updatedAt" < $2::timestamptz - make_interval(days => $3)`,
                [table.id, now, days],
              )
            : await this.ds.query<[unknown, number]>(
                `DELETE FROM "record" WHERE "tableId" = $1
                 AND ("data" ->> $4) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                 AND left("data" ->> $4, 10)::date < ($2::timestamptz - make_interval(days => $3))::date`,
                [table.id, now, days, from],
              );
        if (deleted > 0) {
          swept.push({
            companyId: table.companyId,
            table: table.name,
            deleted,
          });
        }
      } catch (err) {
        onError(table.name, err);
      }
    }
    return swept;
  }

  private aggregateExpr(sql: RecordSql, query: AggregateQuery): string {
    if (query.op === 'count') {
      return query.field ? `count(${sql.expr(query.field)})` : 'count(*)';
    }
    if (!query.field) {
      throw new RecordsError(`'${query.op}' needs a field to work on`);
    }
    const type = sql.fieldType(query.field);
    const numeric = type === 'number' || type === 'integer';
    if (
      !numeric &&
      !(type === 'string' && query.op !== 'sum' && query.op !== 'avg')
    ) {
      throw new RecordsError(
        `'${query.op}' needs a number field; '${query.field}' holds ${type} values`,
      );
    }
    return `${query.op}(${sql.expr(query.field)})`;
  }

  /** Total matches, for a page past the end (where the window count has no row to ride on). */
  private async count(table: TableRow, query: RecordQuery): Promise<number> {
    const sql = new RecordSql(table.schema);
    const tableParam = sql.bind(table.id);
    const companyParam = sql.bind(table.companyId);
    const where = sql.where(query.filters);
    const [{ total }] = await this.ds.query<{ total: number }[]>(
      `SELECT count(*)::int AS total FROM "record" r
       WHERE r."tableId" = ${tableParam} AND r."companyId" = ${companyParam} AND ${where}`,
      sql.params,
    );
    return total;
  }

  /**
   * Loads a table by name within the company, or says which tables exist.
   * Inside a transaction, `share` holds the definition steady for a write
   * (writes don't block each other) and `update` holds it for a column
   * change, which waits for writes in flight and makes new ones wait. Take
   * it before any record lock, so locks are always taken in the same order.
   */
  private async table(
    manager: EntityManager,
    companyId: string,
    name: string,
    lock?: 'share' | 'update',
  ): Promise<TableRow> {
    const forLock = lock ? `FOR ${lock.toUpperCase()}` : '';
    const [table] = await manager.query<TableRow[]>(
      `SELECT "id", "companyId", "name", "purpose", "schema", "primaryKey", "uniqueKeys", "retention"
       FROM "record_table" WHERE "companyId" = $1 AND "name" = $2 ${forLock}`,
      [companyId, name],
    );
    if (!table) {
      throw new RecordsError(
        `there is no table named '${name}' — call list_tables to see the tables, or create_table to make one`,
        'not_found',
      );
    }
    return table;
  }

  /**
   * Sets every record's data of the table to `expr` and bumps its version;
   * returns how many changed. `$1` in `expr` and `where` is the table id.
   */
  private async rewriteRows(
    tx: EntityManager,
    expr: string,
    params: unknown[],
    where = 'true',
  ): Promise<number> {
    // TypeORM answers an UPDATE with [rows, affectedCount].
    const [, count] = await tx.query<[unknown, number]>(
      `UPDATE "record" SET "data" = ${expr}, "version" = "version" + 1
       WHERE "tableId" = $1 AND ${where}`,
      params,
    );
    return count;
  }

  /**
   * Converts one column's values to its new type (see {@link convertValue}),
   * rewriting only the records whose value changes, then rebuilds every key
   * the column is in, since a key's stored value holds the values' JSON.
   *
   * Values that don't convert stop it: an agent is told to ask a person; a
   * person must confirm with `blankUnconvertible`, and even then a required
   * or key column is refused, since its values can't be blank.
   */
  private async retype(
    tx: EntityManager,
    table: TableRow,
    column: string,
    field: FieldSchema,
    opts: AlterOptions,
  ): Promise<{ rewritten: number; blanked: number }> {
    const rows = await tx.query<{ id: string; value: unknown }[]>(
      `SELECT "id"::text AS "id", "data" -> $2::text AS "value" FROM "record"
       WHERE "tableId" = $1 AND jsonb_exists("data", $2::text)`,
      [table.id, column],
    );
    const converted = rows.map((r) => ({
      ...r,
      to: convertValue(r.value, field),
    }));
    const failed = converted.filter((r) => r.to === undefined);
    if (failed.length) {
      const examples = failed
        .slice(0, 3)
        .map((r) => `record ${r.id}: ${JSON.stringify(r.value)}`)
        .join('; ');
      const what = `${failed.length === 1 ? "1 value doesn't" : `${failed.length} values don't`} convert to ${typeWords(field)} in '${column}', e.g. ${examples}`;
      if (!opts.byPerson) {
        throw new RecordsError(
          `${what}. Fix them with update first, or ask a user with request_user_input to change the type in the table's Columns dialog, where values that don't convert can be blanked`,
          'unconvertible',
        );
      }
      const inKey = [table.primaryKey, ...table.uniqueKeys].some((key) =>
        key.includes(column),
      );
      if (inKey || table.schema.required?.includes(column)) {
        throw new RecordsError(
          `${what}. '${column}' is ${inKey ? 'in a key' : 'required'}, so they can't be blanked: fix them first`,
        );
      }
      if (!opts.blankUnconvertible) {
        throw new RecordsError(
          `${what}. Changing the type blanks them`,
          'unconvertible',
        );
      }
    }
    const changed = converted.filter(
      (r) => JSON.stringify(r.to) !== JSON.stringify(r.value),
    );
    if (changed.length) {
      await tx.query(
        `UPDATE "record" r
         SET "data" = CASE WHEN v."value" IS NULL THEN r."data" - $2::text
                           ELSE jsonb_set(r."data", ARRAY[$2::text], v."value"::jsonb) END,
             "version" = r."version" + 1
         FROM unnest($3::uuid[], $4::text[]) AS v("id", "value")
         WHERE r."id" = v."id" AND r."tableId" = $1`,
        [
          table.id,
          column,
          changed.map((r) => r.id),
          changed.map((r) =>
            r.to === undefined ? null : JSON.stringify(r.to),
          ),
        ],
      );
      for (const key of [table.primaryKey, ...table.uniqueKeys]) {
        if (key.includes(column)) await this.rebuildKey(tx, table, key, key);
      }
    }
    return { rewritten: changed.length, blanked: failed.length };
  }

  /**
   * Replaces the stored values of the key `oldKey` (none, for a new key) with
   * those of `key`, from every record. Refuses, with examples, when a record
   * has no value for a key field or two records would share a key: the
   * caller holds the table's update lock, so nothing can change between this
   * check and the write.
   */
  // ponytail: reads every record into memory; fine to the 10,000-row scale,
  // page through them if a table grows far past that.
  private async rebuildKey(
    tx: EntityManager,
    table: TableRow,
    oldKey: string[] | null,
    key: string[],
  ): Promise<void> {
    const rows = await tx.query<{ id: string; data: RecordData }[]>(
      `SELECT "id"::text AS "id", "data" FROM "record" WHERE "tableId" = $1`,
      [table.id],
    );
    for (const field of key) {
      const missing = rows.filter((r) => r.data[field] === undefined);
      if (missing.length) {
        const ids = missing.slice(0, 3).map((r) => r.id);
        throw new RecordsError(
          `${missing.length === 1 ? '1 record has' : `${missing.length} records have`} no value for '${field}', and every key field needs one. ` +
            `Fill it in with update (for example record ${ids.join(', ')}), then try again`,
        );
      }
    }
    const holders = new Map<string, number>();
    for (const r of rows) {
      const value = keyValue(key, r.data);
      holders.set(value, (holders.get(value) ?? 0) + 1);
    }
    const clashes = [...holders].filter(([, n]) => n > 1);
    if (clashes.length) {
      const examples = clashes.slice(0, 3).map(([value, n]) => {
        const values = JSON.parse(value) as unknown[];
        const named = key.map((f, i) => `${f}=${JSON.stringify(values[i])}`);
        return `${named.join(', ')} (${n} records)`;
      });
      throw new RecordsError(
        `that key would not tell records apart: ${clashes.length === 1 ? '1 value is' : `${clashes.length} values are`} shared, e.g. ${examples.join('; ')}. ` +
          'Add a field that tells them apart, or change those records first',
        'conflict',
      );
    }
    if (oldKey) {
      await tx.query(
        `DELETE FROM "record_key" WHERE "tableId" = $1 AND "keyName" = $2`,
        [table.id, keyName(oldKey)],
      );
    }
    await tx.query(
      `INSERT INTO "record_key" ("tableId", "keyName", "keyValue", "recordId")
       SELECT $1, $2, t."value", t."recordId" FROM unnest($3::text[], $4::uuid[]) AS t("value", "recordId")`,
      [
        table.id,
        keyName(key),
        rows.map((r) => keyValue(key, r.data)),
        rows.map((r) => r.id),
      ],
    );
  }

  /** Every key the table declares, primary first, with its stored name and value for `data`. */
  private keys(
    table: TableDefinition,
    data: RecordData,
  ): { fields: string[]; name: string; value: string }[] {
    return [table.primaryKey, ...table.uniqueKeys].map((fields) => ({
      fields,
      name: keyName(fields),
      value: keyValue(fields, data),
    }));
  }

  private async writeKeys(
    tx: EntityManager,
    table: TableDefinition,
    recordId: string,
    data: RecordData,
  ): Promise<void> {
    for (const key of this.keys(table, data)) {
      await tx.query(
        `INSERT INTO "record_key" ("tableId", "keyName", "keyValue", "recordId") VALUES ($1, $2, $3, $4)`,
        [table.id, key.name, key.value, recordId],
      );
    }
  }

  /** The record already holding one of `data`'s keys, as an `already_exists` result. */
  private async findByKeys(
    manager: EntityManager,
    table: TableDefinition,
    data: RecordData,
  ): Promise<InsertResult | undefined> {
    for (const key of this.keys(table, data)) {
      const [row] = await manager.query<RecordRowSql[]>(
        `SELECT r."id", r."data", r."version" FROM "record_key" k
         JOIN "record" r ON r."id" = k."recordId"
         WHERE k."tableId" = $1 AND k."keyName" = $2 AND k."keyValue" = $3`,
        [table.id, key.name, key.value],
      );
      if (row) {
        return {
          status: 'already_exists',
          record: toStored(row),
          key: Object.fromEntries(key.fields.map((f) => [f, data[f]])),
          matches: canonicalJson(row.data) === canonicalJson(data),
        };
      }
    }
    return undefined;
  }

  /** Finds the record a ref points at, within this table and company, optionally locking it. */
  private async resolve(
    manager: EntityManager,
    table: TableRow,
    ref: RecordRef,
    lock: boolean,
  ): Promise<StoredRecord> {
    const forUpdate = lock ? 'FOR UPDATE OF r' : '';
    let rows: RecordRowSql[];
    if ('id' in ref) {
      rows = await manager.query<RecordRowSql[]>(
        `SELECT r."id", r."data", r."version" FROM "record" r
         WHERE r."id"::text = $1 AND r."tableId" = $2 AND r."companyId" = $3 ${forUpdate}`,
        [ref.id, table.id, table.companyId],
      );
    } else {
      const missing = table.primaryKey.filter((f) => ref.key[f] === undefined);
      if (missing.length) {
        throw new RecordsError(
          `key must give the primary key field(s) ${table.primaryKey.join(', ')}; missing ${missing.join(', ')}`,
        );
      }
      rows = await manager.query<RecordRowSql[]>(
        `SELECT r."id", r."data", r."version" FROM "record_key" k
         JOIN "record" r ON r."id" = k."recordId"
         WHERE k."tableId" = $1 AND k."keyName" = $2 AND k."keyValue" = $3 AND r."companyId" = $4
         ${forUpdate}`,
        [
          table.id,
          keyName(table.primaryKey),
          keyValue(table.primaryKey, ref.key),
          table.companyId,
        ],
      );
    }
    if (!rows[0]) {
      throw new RecordsError(
        `no record matches ${JSON.stringify('id' in ref ? { id: ref.id } : ref.key)} in '${table.name}' — use query to find it`,
        'not_found',
      );
    }
    return toStored(rows[0]);
  }
}
