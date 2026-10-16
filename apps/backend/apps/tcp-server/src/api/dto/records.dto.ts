import {
  ApiProperty,
  ApiPropertyOptional,
  getSchemaPath,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
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

/**
 * How long a table keeps its rows: `days` after `from`, which is a date field
 * of the table or `updated` for the row's last change.
 */
export class RecordTableRetentionDto {
  @IsInt()
  @Min(1)
  days!: number;
  @IsString()
  @IsNotEmpty()
  from!: string;
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
  /** How long rows are kept; null when they are kept until deleted. */
  retention!: RecordTableRetentionDto | null;
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

/** Text to look for across every table. */
export class SearchRecordsDto {
  @IsString()
  @MaxLength(200)
  q!: string;
}

/** One table's rows that matched a search. */
export class RecordSearchGroupDto {
  definition!: RecordTableDefinitionDto;
  rows!: TimedRecordDto[];
}

/** Rows across every table that matched a search, grouped by table. */
export class RecordSearchResultDto {
  groups!: RecordSearchGroupDto[];
  /** True when there were more matches than a search returns (1,000). */
  truncated!: boolean;
}

/** Which rows to export: per table, a list of record ids or `all`. */
export class ExportRecordsDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: {
      oneOf: [
        { type: 'string', enum: ['all'] },
        { type: 'array', items: { type: 'string' } },
      ],
    },
  })
  @IsObject()
  tables!: Record<string, string[] | 'all'>;
}

/** A record to act on, at the version the caller last saw. */
export class VersionedRefDto {
  @IsString()
  id!: string;
  @IsInt()
  @Min(1)
  version!: number;
}

/** Records to delete together, all or none. */
export class DeleteRecordsDto {
  @IsArray()
  @ArrayMaxSize(10_000)
  @ValidateNested({ each: true })
  @Type(() => VersionedRefDto)
  rows!: VersionedRefDto[];
}

/** A table's new retention, or null to keep rows until deleted. */
export class SetRetentionDto {
  @ApiProperty({ type: RecordTableRetentionDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => RecordTableRetentionDto)
  retention!: RecordTableRetentionDto | null;
}

/** A column to add to a table. */
export class AddColumnDto {
  @IsString()
  column!: string;
  @ApiProperty({ enum: ['string', 'number', 'integer', 'boolean'] })
  @IsIn(['string', 'number', 'integer', 'boolean'])
  type!: 'string' | 'number' | 'integer' | 'boolean';
  /** `date` for a text column holding `YYYY-MM-DD`. */
  @ApiPropertyOptional({ enum: ['date'] })
  @IsOptional()
  @IsIn(['date'])
  format?: 'date';
  @IsOptional()
  @IsString()
  description?: string;
  @ApiPropertyOptional({
    description: 'Given to every existing record',
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  })
  @IsOptional()
  default?: string | number | boolean;
  /** Allowed only with a default, or on an empty table. */
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}

/** A column's new name. */
export class RenameColumnDto {
  @IsString()
  newName!: string;
}

/** The fields that make up a table's primary key. */
export class SetPrimaryKeyDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  fields!: string[];
}

/** The fields that make up a unique key. */
export class UniqueKeyDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  fields!: string[];
}

/** A column's new type. */
export class RetypeColumnDto {
  @ApiProperty({ enum: ['string', 'number', 'integer', 'boolean'] })
  @IsIn(['string', 'number', 'integer', 'boolean'])
  type!: 'string' | 'number' | 'integer' | 'boolean';
  /** `date` for a text column holding `YYYY-MM-DD`. */
  @ApiPropertyOptional({ enum: ['date'] })
  @IsOptional()
  @IsIn(['date'])
  format?: 'date';
}

/** An entry on the do-not-store list. */
export class DoNotStoreEntryDto {
  id!: string;
  /** A name, email address or other text agents may not store. */
  value!: string;
  note!: string | null;
  @ApiProperty({ enum: ['user', 'agent'] })
  addedByRole!: 'user' | 'agent';
  /** The user identifier or agent id that added it, when known. */
  addedById!: string | null;
  createdAt!: string;
  updatedAt!: string;
}

/** A new do-not-store entry. */
export class AddDoNotStoreDto {
  @IsString()
  @MaxLength(200)
  value!: string;
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Changes to a do-not-store entry. */
export class UpdateDoNotStoreDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  value?: string;
  @ApiProperty({ type: String, nullable: true, required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string | null;
}
