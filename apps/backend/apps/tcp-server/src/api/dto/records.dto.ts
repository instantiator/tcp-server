import { ApiProperty, getSchemaPath } from '@nestjs/swagger';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/**
 * Request and response shapes for `records.controller.ts`.
 *
 * The response classes mirror `@tcp/shared`'s records interfaces field for
 * field, so the Swagger plugin has a class to read (an interface publishes as
 * `Record<string, never>`; see `knowledge-response.dto.ts`). Record values are
 * open objects — their fields are whatever the table's schema says — so they
 * are declared with `additionalProperties` by hand.
 */

/** Swagger metadata for an object with any keys. */
const OPEN_OBJECT = { type: 'object', additionalProperties: true } as const;

/** One field of a table's schema, as far as the web client reads it. */
export class RecordFieldSchemaDto {
  @ApiProperty({ enum: ['string', 'number', 'integer', 'boolean'] })
  type!: 'string' | 'number' | 'integer' | 'boolean';
  /** `date` for a `YYYY-MM-DD` text field. */
  format?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
}

/** A table's JSON Schema: a closed object of scalar fields. */
export class RecordTableSchemaDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: { $ref: getSchemaPath(RecordFieldSchemaDto) },
  })
  properties!: Record<string, RecordFieldSchemaDto>;
  required?: string[];
}

/** A table's definition. */
export class RecordTableDefinitionDto {
  id!: string;
  name!: string;
  purpose!: string;
  schema!: RecordTableSchemaDto;
  /** The primary key's fields. */
  primaryKey!: string[];
  /** Each further unique key's fields. */
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
  })
  uniqueKeys!: string[][];
}

/** A table in a company's list of tables. */
export class RecordTableSummaryDto {
  name!: string;
  purpose!: string;
  /** How many records it holds. */
  records!: number;
  /** When a record last changed, or the table was made if it has none (ISO 8601). */
  updatedAt!: string;
}

/** A stored record with its timestamps. */
export class TimedRecordDto {
  id!: string;
  @ApiProperty(OPEN_OBJECT)
  data!: Record<string, unknown>;
  /** Goes up by one on every change; send it back with an edit. */
  version!: number;
  createdAt!: string;
  updatedAt!: string;
}

/** A table's definition and rows, most recently changed first. */
export class RecordTableRowsDto {
  definition!: RecordTableDefinitionDto;
  rows!: TimedRecordDto[];
  /** How many records the table holds in all. */
  total!: number;
  /** Whether `rows` stops short of `total`. */
  truncated!: boolean;
}

/** What a CSV append added. */
export class AppendRecordsCsvResultDto {
  inserted!: number;
  /** Rows skipped because a record already holds their key. */
  alreadyExists!: number;
}

/** How many records a clear or delete removed. */
export class RemovedRecordsDto {
  removed!: number;
}

/**
 * A new table, as an agent's `create_table` takes it. The records service
 * checks the name and schema; this only checks the shape of the request.
 */
export class CreateRecordTableDto {
  /** Lower case letters, digits and `_`, starting with a letter. */
  @IsString()
  name!: string;
  @IsString()
  purpose!: string;
  /** A JSON Schema object whose properties are scalar fields. */
  @ApiProperty(OPEN_OBJECT)
  @IsObject()
  schema!: Record<string, unknown>;
  /** The primary key's fields: required, and string or integer. */
  @IsArray()
  @IsString({ each: true })
  primaryKey!: string[];
  /** Each further unique key's fields. */
  @ApiProperty({
    type: 'array',
    items: { type: 'array', items: { type: 'string' } },
    required: false,
  })
  @IsOptional()
  @IsArray()
  uniqueKeys?: string[][];
}

/** A record to add. */
export class AddRecordDto {
  @ApiProperty(OPEN_OBJECT)
  @IsObject()
  data!: Record<string, unknown>;
}

/** Changes to a record: `null` removes a field. */
export class UpdateRecordDto {
  @ApiProperty(OPEN_OBJECT)
  @IsObject()
  changes!: Record<string, unknown>;
  /** The version the change was made against; a newer record refuses it. */
  @IsInt()
  @Min(1)
  version!: number;
}
