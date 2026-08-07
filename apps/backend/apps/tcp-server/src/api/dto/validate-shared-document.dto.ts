import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Body for `POST /api/storage/validate`. */
export class ValidateSharedDocumentDto {
  /** A specific object key, or a glob pattern (`*`, `?`) matched against full keys. */
  @IsString()
  path!: string;

  /**
   * When `path` names a directory prefix (no exact file match) or a glob,
   * whether to include nested entries beyond the immediate prefix level.
   * Defaults to `false`.
   */
  @IsOptional()
  @IsBoolean()
  recursive?: boolean;
}
