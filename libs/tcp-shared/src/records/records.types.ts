import type { UUID } from '../uuid';

/**
 * A request the caller can correct: an unknown table, a record that fails its
 * schema, a key that clashes. The message is written for a language model, so
 * it says what was wrong and what to do instead.
 */
export class RecordsError extends Error {
  override readonly name = 'RecordsError';

  constructor(
    message: string,
    /** What kind of mistake it was, so an HTTP caller can pick a status. */
    readonly code: RecordsErrorCode = 'invalid',
  ) {
    super(message);
  }
}

/**
 * `invalid`: the request itself is wrong. `not_found`: no such table or record.
 * `conflict`: a key or name another row already holds. `stale`: the record
 * changed since the caller read it.
 */
export type RecordsErrorCode = 'invalid' | 'not_found' | 'conflict' | 'stale';

/** The JSON types a top-level record field may have. Scalars only, so every field can be filtered, sorted and grouped. */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean';

/** One field of a table's JSON Schema, as far as the records server reads it. */
export interface FieldSchema {
  type: FieldType;
  [keyword: string]: unknown;
}

/** A table's JSON Schema: a closed object of scalar fields. */
export interface TableSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required?: string[];
  additionalProperties: false;
  [keyword: string]: unknown;
}

/** What an agent supplies to create a table. */
export interface NewTable {
  name: string;
  purpose: string;
  schema: Record<string, unknown>;
  primaryKey: string[];
  uniqueKeys?: string[][];
}

/**
 * How long a table keeps its rows: `days` after `from`, which is a date field
 * of the table, or `updated` for the row's last change. Set by people only.
 */
export interface TableRetention {
  days: number;
  from: string;
}

/** A table as stored and as `describe_table` returns it. */
export interface TableDefinition {
  id: string;
  name: string;
  purpose: string;
  schema: TableSchema;
  primaryKey: string[];
  uniqueKeys: string[][];
  /** Null when rows are kept until someone deletes them. */
  retention: TableRetention | null;
}

/** A record's field values. */
export type RecordData = Record<string, unknown>;

/** A stored record. */
export interface StoredRecord {
  id: string;
  data: RecordData;
  version: number;
}

/** A stored record with its timestamps (ISO 8601), for people rather than agents. */
export interface TimedRecord extends StoredRecord {
  createdAt: string;
  updatedAt: string;
}

/** A table with its size, for a list of tables. */
export interface TableSummary {
  name: string;
  purpose: string;
  records: number;
  /** When a record last changed, or the table was made if it has none. */
  updatedAt: string;
}

/** A table's rows for display, newest change first, possibly cut short. */
export interface TableRows {
  definition: TableDefinition;
  rows: TimedRecord[];
  total: number;
  truncated: boolean;
}

/** One table's rows that matched a search. */
export interface SearchGroup {
  definition: TableDefinition;
  rows: TimedRecord[];
}

/** Rows across every table that matched a search, grouped by table. */
export interface SearchResult {
  groups: SearchGroup[];
  /** True when there were more matches than a search returns. */
  truncated: boolean;
}

/** A record to act on, at the version the caller last saw. */
export interface VersionedRef {
  id: string;
  version: number;
}

/** What a retention sweep deleted from one table. */
export interface RetentionSweep {
  companyId: UUID;
  table: string;
  deleted: number;
}

/**
 * One entry on a company's do-not-store list: text, such as a person's name
 * or email address, that agents may not store in a record table.
 */
export interface DoNotStoreEntry {
  id: string;
  value: string;
  note: string | null;
  /** Who added it: a person or an agent. */
  addedByRole: 'user' | 'agent';
  /** The user identifier or agent id that added it, when known. */
  addedById: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row that failed its schema in a batch insert; `row` counts from 1. */
export interface RowError {
  row: number;
  message: string;
}

/** The result of a batch insert. When `errors` isn't empty, nothing was inserted. */
export interface InsertManyResult {
  inserted: number;
  alreadyExists: number;
  errors: RowError[];
}

/** Picks one record: by its id, or by the values of the table's primary key fields. */
export type RecordRef = { id: string } | { key: RecordData };

/** The result of an insert: a new record, or the one already holding that key. */
export type InsertResult =
  | { status: 'inserted'; record: StoredRecord }
  | {
      status: 'already_exists';
      /** The existing record. */
      record: StoredRecord;
      /** The key that matched, e.g. `{ order_id: "A1" }`. */
      key: RecordData;
      /** Whether the existing record holds exactly the data that was offered. */
      matches: boolean;
    };

/** A change and the values either side of it, for the audit trail. */
export interface RecordChange {
  record: StoredRecord;
  before: RecordData;
}

/** The comparison operators `query` and `aggregate` filters accept. */
export const FILTER_OPS = [
  'eq',
  'ne',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'in',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** One filter; a query's filters are ANDed. */
export interface RecordFilter {
  field: string;
  op: FilterOp;
  value: unknown;
}

/** What `query` accepts. */
export interface RecordQuery {
  filters?: RecordFilter[];
  sort?: { field: string; direction?: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

/** A page of matching records, with how many match in all. */
export interface QueryResult {
  records: StoredRecord[];
  total: number;
}

/** The aggregate functions `aggregate` offers. */
export const AGGREGATE_OPS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type AggregateOp = (typeof AGGREGATE_OPS)[number];

/** What `aggregate` accepts. */
export interface AggregateQuery {
  op: AggregateOp;
  field?: string;
  groupBy?: string[];
  filters?: RecordFilter[];
}

/** One aggregate value, per group when grouped. Values are decimal strings, so totals stay exact. */
export interface AggregateRow {
  group: RecordData;
  value: string | null;
}
