import { ApiProperty } from '@nestjs/swagger';
import type { StorageObject } from '../../storage/storage.service';
import type { TaskMaterialSummary } from '../task.service';

/** `POST /api/storage`: where the upload landed and how big it was. */
export class StoredObjectResponseDto {
  key!: string;
  /** Bytes written. */
  size!: number;
}

/** One document's result in {@link ValidateSharedDocumentResponseDto.validations}. */
export class ValidationEntryDto {
  path!: string;
  found!: boolean;
  size!: number;
  valid!: boolean;
  errors!: string[];
}

/** The request as the server understood it. */
export class ValidateSharedDocumentQueryDto {
  path!: string;
  recursive!: boolean;
}

/** `POST /api/storage/validate`. */
export class ValidateSharedDocumentResponseDto {
  query!: ValidateSharedDocumentQueryDto;
  @ApiProperty({ type: ValidationEntryDto, isArray: true })
  validations!: ValidationEntryDto[];
}

/** A stored object, as the `/internal/storage` list and search routes return it. */
export class StorageObjectDto implements StorageObject {
  /** Full object key (e.g. `acme/knowledge/analyst/report.md`). */
  key!: string;
  /** Filename component (basename) extracted from the key. */
  name!: string;
  /** Object size in bytes. */
  size!: number;
  lastModified!: Date;
  /** Entity tag (content hash) of the object, when the backend reports one. */
  etag?: string;
}

/** `POST /internal/storage/list` and `/search`. */
export class StorageEntriesResponseDto {
  @ApiProperty({ type: StorageObjectDto, isArray: true })
  entries!: StorageObjectDto[];
}

/** `POST /internal/storage/read`. */
export class FileContentResponseDto {
  content!: string;
}

/** `POST /internal/storage/append`. */
export class AppendFileResponseDto {
  key!: string;
  /** Size in bytes after the append. */
  size!: number;
  /** True when the file did not exist and the append created it. */
  created!: boolean;
}

/** `POST /internal/storage/replace`. */
export class ReplaceFileResponseDto {
  key!: string;
  /** Occurrences replaced. */
  count!: number;
}

/** `POST /internal/storage/delete`: the object went to the restorable bin. */
export class FileDeletedResponseDto {
  @ApiProperty({ enum: [true] })
  restorable!: true;
}

/** `POST /internal/storage/restore`. */
export class FileRestoredResponseDto {
  @ApiProperty({ enum: [true] })
  restored!: true;
}

/** `POST /internal/storage/copy`. */
export class FileCopiedResponseDto {
  @ApiProperty({ enum: [true] })
  copied!: true;
}

/** `POST /internal/storage/move`. */
export class FileMovedResponseDto {
  @ApiProperty({ enum: [true] })
  moved!: true;
}

/** `POST /internal/storage/properties`: the size/type fields are present only when `exists`. */
export class FilePropertiesResponseDto {
  key!: string;
  exists!: boolean;
  size?: number;
  contentType?: string;
  lastModified?: Date;
}

/** `GET /internal/storage/exists`: which of the asked-about paths are absent. */
export class MissingFilesResponseDto {
  missing!: string[];
}

/** `POST /api/task/:id/materials`. */
export class TaskMaterialResponseDto implements TaskMaterialSummary {
  key!: string;
  name!: string;
  size!: number;
}
