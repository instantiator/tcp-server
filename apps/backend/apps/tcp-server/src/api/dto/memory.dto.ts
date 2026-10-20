import {
  MAX_MEMORY_LENGTH,
  MAX_MEMORY_TAGS,
  MAX_MEMORY_TAG_LENGTH,
} from '@tcp/shared';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { UUID } from 'crypto';

/** Trims a string body field, so whitespace alone counts as empty. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** One thing a role remembers. */
export class MemoryDto {
  /** @format uuid */
  id!: UUID;
  content!: string;
  @ApiProperty({ type: String, isArray: true })
  tags!: string[];
  /** The agent that wrote it, or `null` when a person did. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  agentId!: UUID | null;
  /** Goes up by one on every edit. */
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

/** `GET /api/role/:roleId/memory`: the role's memories, newest first. */
export class MemoryListDto {
  @ApiProperty({ type: MemoryDto, isArray: true })
  memories!: MemoryDto[];
  /** Whether older memories were left out (only the newest 500 are listed). */
  truncated!: boolean;
  /** Whether memories can be added or reworded: false without an embedding model. */
  canWrite!: boolean;
}

/** `POST /api/role/:roleId/memory`. */
export class CreateMemoryDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MEMORY_LENGTH)
  content!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMORY_TAGS)
  @IsString({ each: true })
  @MaxLength(MAX_MEMORY_TAG_LENGTH, { each: true })
  tags?: string[];
}

/** `PATCH /api/role/:roleId/memory/:id`: only the fields given change. */
export class UpdateMemoryDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_MEMORY_LENGTH)
  content?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEMORY_TAGS)
  @IsString({ each: true })
  @MaxLength(MAX_MEMORY_TAG_LENGTH, { each: true })
  tags?: string[];
}
