import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import type { MemberType } from '@lcp/shared';

const MEMBER_TYPES = ['creator', 'owner', 'member'] as const;

export class CreateCompanyUserDto {
  @IsString()
  @IsNotEmpty()
  identifier!: string;

  @IsIn(MEMBER_TYPES)
  memberType!: MemberType;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knowledgeDomains?: string[];
}

export class UpdateCompanyUserDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsIn(MEMBER_TYPES)
  memberType?: MemberType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knowledgeDomains?: string[];
}
