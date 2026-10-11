import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { RecordSql } from './filter-sql';
import {
  AGGREGATE_OPS,
  type AggregateQuery,
  type AggregateRow,
  type InsertResult,
  type NewTable,
  type QueryResult,
  type RecordChange,
  type RecordData,
  type RecordQuery,
  type RecordRef,
  RecordsError,
  type StoredRecord,
  type TableDefinition,
} from './records.types';
import {
  RECORD_LIMITS,
  canonicalJson,
  checkNewTable,
  checkRecord,
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

function toStored(row: RecordRowSql): StoredRecord {
  return { id: row.id, data: row.data, version: row.version };
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
    const table = await this.table(this.ds.manager, companyId, name);
    return {
      id: table.id,
      name: table.name,
      purpose: table.purpose,
      schema: table.schema,
      primaryKey: table.primaryKey,
      uniqueKeys: table.uniqueKeys,
    };
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
      };
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new RecordsError(
          `a table named '${table.name}' already exists — use describe_table to see it`,
        );
      }
      throw e;
    }
  }

  /**
   * Inserts a record, or returns the one already holding its primary or a
   * unique key. Never creates a duplicate: when two inserts race, the
   * `record_key` primary key lets exactly one commit, and the other is
   * answered with the winner.
   */
  async insert(
    companyId: string,
    tableName: string,
    data: RecordData,
  ): Promise<InsertResult> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    checkRecord(recordValidator(table.schema), data);
    const existing = await this.findByKeys(table, data);
    if (existing) return existing;
    try {
      return await this.ds.transaction(async (tx) => {
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
      const winner = await this.findByKeys(table, data);
      if (winner) return winner;
      throw e;
    }
  }

  /**
   * Merges `changes` into a record (`null` removes a field), re-checks it
   * against the schema and rewrites its keys. The row is locked for the
   * duration, so two concurrent updates apply one after the other.
   */
  async update(
    companyId: string,
    tableName: string,
    ref: RecordRef,
    changes: RecordData,
  ): Promise<RecordChange> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    const validate = recordValidator(table.schema);
    try {
      return await this.ds.transaction(async (tx) => {
        const current = await this.resolve(tx, table, ref, true);
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
        );
      }
      throw e;
    }
  }

  /** Deletes a record; the returned `before` is all that remains of it. */
  async delete(
    companyId: string,
    tableName: string,
    ref: RecordRef,
  ): Promise<RecordChange> {
    const table = await this.table(this.ds.manager, companyId, tableName);
    return this.ds.transaction(async (tx) => {
      const current = await this.resolve(tx, table, ref, true);
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

  /** Deletes every table (and so every record) of a company. Returns how many tables went. */
  async deleteCompany(companyId: string): Promise<number> {
    // TypeORM answers a DELETE with [rows, affectedCount].
    const [, count] = await this.ds.query<[unknown, number]>(
      `DELETE FROM "record_table" WHERE "companyId" = $1`,
      [companyId],
    );
    return count;
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

  /** Loads a table by name within the company, or says which tables exist. */
  private async table(
    manager: EntityManager,
    companyId: string,
    name: string,
  ): Promise<TableRow> {
    const [table] = await manager.query<TableRow[]>(
      `SELECT "id", "companyId", "name", "purpose", "schema", "primaryKey", "uniqueKeys"
       FROM "record_table" WHERE "companyId" = $1 AND "name" = $2`,
      [companyId, name],
    );
    if (!table) {
      throw new RecordsError(
        `there is no table named '${name}' — call list_tables to see the tables, or create_table to make one`,
      );
    }
    return table;
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
    table: TableDefinition,
    data: RecordData,
  ): Promise<InsertResult | undefined> {
    for (const key of this.keys(table, data)) {
      const [row] = await this.ds.query<RecordRowSql[]>(
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
      );
    }
    return toStored(rows[0]);
  }
}
