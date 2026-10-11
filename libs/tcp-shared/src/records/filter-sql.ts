import {
  FILTER_OPS,
  type FieldType,
  type RecordFilter,
  RecordsError,
  type TableSchema,
} from './records.types';

/**
 * Builds parameterised SQL over `record r` for one table. Every field name and
 * every value is a bound parameter — nothing an agent supplies is spliced into
 * the SQL text — and field names are checked against the table's schema first,
 * so a typo gets a clear error rather than an empty result.
 */
export class RecordSql {
  readonly params: unknown[] = [];

  constructor(private readonly schema: TableSchema) {}

  /** Binds a value and returns its placeholder. */
  bind(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  /** The field's declared type, or a {@link RecordsError} naming the fields there are. */
  fieldType(field: unknown): FieldType {
    const property =
      typeof field === 'string' && Object.hasOwn(this.schema.properties, field)
        ? this.schema.properties[field]
        : undefined;
    if (!property) {
      throw new RecordsError(
        `unknown field '${String(field)}' — the table's fields are ${Object.keys(this.schema.properties).join(', ')}`,
      );
    }
    return property.type;
  }

  /** The field's value as a typed SQL expression: numeric fields compare as numbers, so 10 > 9. */
  expr(field: string): string {
    const type = this.fieldType(field);
    const text = `(r.data ->> ${this.bind(field)})`;
    if (type === 'number' || type === 'integer') return `${text}::numeric`;
    if (type === 'boolean') return `${text}::boolean`;
    return text;
  }

  /** The field's raw JSON value, for grouping and returning group keys with their types intact. */
  jsonExpr(field: string): string {
    this.fieldType(field);
    return `(r.data -> ${this.bind(field)})`;
  }

  /** ANDs the filters into SQL conditions (none → `TRUE`). */
  where(filters: RecordFilter[] | undefined): string {
    const conditions = (filters ?? []).map((f) => this.condition(f));
    return conditions.length ? conditions.join(' AND ') : 'TRUE';
  }

  private condition({ field, op, value }: RecordFilter): string {
    if (!FILTER_OPS.includes(op)) {
      throw new RecordsError(
        `unknown filter op '${String(op)}' — use one of ${FILTER_OPS.join(', ')}`,
      );
    }
    const type = this.fieldType(field);
    const left = this.expr(field);
    if (op === 'contains') {
      if (type !== 'string' || typeof value !== 'string') {
        throw new RecordsError(
          `'contains' needs a text field and a text value (field '${field}')`,
        );
      }
      const pattern = `%${value.replace(/[\\%_]/g, '\\$&')}%`;
      return `${left} ILIKE ${this.bind(pattern)}`;
    }
    if (op === 'in') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
        throw new RecordsError(
          `'in' needs a list of 1 to 100 values (field '${field}')`,
        );
      }
      return `${left} = ANY(${this.bind(value.map((v) => this.text(field, type, v)))}::${this.sqlType(type)}[])`;
    }
    if (type === 'boolean' && op !== 'eq' && op !== 'ne') {
      throw new RecordsError(
        `a true/false field can only use eq or ne (field '${field}')`,
      );
    }
    const right = `${this.bind(this.text(field, type, value))}::${this.sqlType(type)}`;
    switch (op) {
      case 'eq':
        return `${left} = ${right}`;
      case 'ne':
        // A record without the field counts as "not equal", which is what people mean.
        return `${left} IS DISTINCT FROM ${right}`;
      case 'lt':
        return `${left} < ${right}`;
      case 'lte':
        return `${left} <= ${right}`;
      case 'gt':
        return `${left} > ${right}`;
      case 'gte':
        return `${left} >= ${right}`;
    }
  }

  private sqlType(type: FieldType): string {
    if (type === 'number' || type === 'integer') return 'numeric';
    return type === 'boolean' ? 'boolean' : 'text';
  }

  /** A filter value as the text Postgres casts, after checking it suits the field. */
  private text(field: string, type: FieldType, value: unknown): string {
    const ok =
      type === 'string'
        ? typeof value === 'string'
        : type === 'boolean'
          ? typeof value === 'boolean'
          : typeof value === 'number' && Number.isFinite(value);
    if (!ok) {
      throw new RecordsError(
        `field '${field}' holds ${type === 'integer' ? 'number' : type} values, so compare it with a ${type === 'integer' ? 'number' : type}, not ${JSON.stringify(value)}`,
      );
    }
    return String(value);
  }
}
