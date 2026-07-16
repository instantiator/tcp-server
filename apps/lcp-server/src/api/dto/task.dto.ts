import type { UUID } from 'crypto';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

/** A task's `expected` artifact: where the task's final output should land, or literal text. */
export class TaskExpectedArtifactDto {
  @IsIn(['task-completed-path', 'inline-text'])
  type!: 'task-completed-path' | 'inline-text';

  @IsString()
  value!: string;
}

/** An inline-text material supplied directly in the create body (file uploads use `POST /api/task/:id/materials`). */
export class InlineTextMaterialDto {
  @IsIn(['inline-text'])
  type!: 'inline-text';

  @IsString()
  value!: string;
}

export class CreateTaskDto {
  @IsUUID()
  companyId!: UUID;

  @IsString()
  @IsNotEmpty()
  request!: string;

  @IsOptional()
  @IsUUID()
  plannerRoleId?: UUID;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskExpectedArtifactDto)
  expected?: TaskExpectedArtifactDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InlineTextMaterialDto)
  materials?: InlineTextMaterialDto[];
}

/**
 * Deep-partial body for `PUT /api/task/:id`. Only accepted while the task is
 * still `ready` (see {@link TaskService.update}) — `id`, `companyId`,
 * `status`, `completed`, and `failureReason` are not editable.
 */
export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  request?: string;

  @IsOptional()
  @IsUUID()
  plannerRoleId?: UUID;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TaskExpectedArtifactDto)
  expected?: TaskExpectedArtifactDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InlineTextMaterialDto)
  materials?: InlineTextMaterialDto[];
}
