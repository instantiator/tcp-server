import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsNotEmpty, IsString } from 'class-validator';

/** A subfolder in a {@link StorageFolderDto} listing. */
export class StorageFolderEntryDto {
  /** Relative to the company folder, ending in `/`. */
  path!: string;
  name!: string;
  /**
   * The first line of the folder's `README.md`. Filled only under
   * `resources/`, and `null` when there is none.
   */
  @ApiProperty({ type: String, nullable: true })
  purpose!: string | null;
}

/** A file in a {@link StorageFolderDto} listing. */
export class StorageFileEntryDto {
  /** Relative to the company folder. */
  path!: string;
  name!: string;
  /** Bytes. */
  size!: number;
  lastModified!: Date;
}

/** `GET /api/company/:companyId/storage/folder`: one level of a folder. */
export class StorageFolderDto {
  /** The folder listed, relative to the company folder (`''` is its root). */
  path!: string;
  /** Whether people may upload into, and delete from, this folder. */
  writable!: boolean;
  @ApiProperty({ type: StorageFolderEntryDto, isArray: true })
  folders!: StorageFolderEntryDto[];
  @ApiProperty({ type: StorageFileEntryDto, isArray: true })
  files!: StorageFileEntryDto[];
}

/** One kept version of a file. */
export class StorageVersionDto {
  versionId!: string;
  /** Bytes. */
  size!: number;
  lastModified!: Date;
  /** Whether this is the file's current version. */
  isLatest!: boolean;
}

/** Where an upload or restore landed. */
export class StoredCompanyFileDto {
  /** Relative to the company folder. */
  path!: string;
  /** Bytes written; absent for a restore. */
  size?: number;
}

/** `POST /api/company/:companyId/storage/zip`. */
export class StorageZipRequestDto {
  /** The folder the zip's entry names are relative to; every path is inside it. */
  @IsString()
  root!: string;
  /** Files, and folders (ending in `/`), to include. */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  paths!: string[];
}

/** `POST /api/company/:companyId/storage/restore`. */
export class StorageRestoreRequestDto {
  /** The file, relative to the company folder. */
  @IsString()
  @IsNotEmpty()
  path!: string;
  @IsString()
  @IsNotEmpty()
  versionId!: string;
}
