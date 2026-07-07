import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Who requested a storage action — see `storage.service.ts`'s `Originators`. */
export class OriginatorsDto {
  @IsOptional()
  @IsString()
  user?: string | null;

  @IsOptional()
  @IsString()
  agent?: string | null;

  @IsOptional()
  @IsString()
  task?: string | null;
}

export class ListFilesDto {
  @IsOptional()
  @IsString()
  prefix?: string;
}

export class ReadFileDto {
  @IsString()
  path!: string;
}

export class WriteFileDto {
  @IsString()
  path!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsBoolean()
  overwrite?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => OriginatorsDto)
  originators?: OriginatorsDto;
}

export class DeleteFileDto {
  @IsString()
  path!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OriginatorsDto)
  originators?: OriginatorsDto;
}

export class RestoreFileDto extends DeleteFileDto {}

export class SearchFilesDto {
  @IsOptional()
  @IsString()
  prefix?: string;

  @IsOptional()
  @IsString()
  pattern?: string;
}

export class GetFilePropertiesDto {
  @IsString()
  path!: string;
}

export class CopyFileDto {
  @IsString()
  source!: string;

  @IsString()
  destination!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => OriginatorsDto)
  originators?: OriginatorsDto;
}

export class MoveFileDto extends CopyFileDto {}

export class GetFileSummaryDto {
  @IsString()
  path!: string;
}
