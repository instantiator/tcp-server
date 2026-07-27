import type { UUID } from 'crypto';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type {
  TcpArtifact,
  TcpAssignmentWorkingArtifact,
  TcpMaterialArtifact,
} from '@lcp/shared';

/**
 * One assignment in a plan submitted via `POST /internal/task/:taskId/plan`.
 * The nested artifact arrays are validated by hand in `AssignmentService`
 * (not with class-validator) so each failure yields a corrective message the
 * MCP layer can relay verbatim to the planning agent.
 */
export interface PlanAssignmentInput {
  prompt: string;
  /** Role id or slug, resolved within the caller's company. */
  role: string;
  expected: TcpAssignmentWorkingArtifact[];
  materials?: TcpMaterialArtifact[];
}

/** Body for `POST /internal/task/:taskId/plan`. */
export class PlanTaskDto {
  @IsUUID()
  agentId!: UUID;

  @IsArray()
  assignments!: PlanAssignmentInput[];
}

/** Body for `POST /internal/assignment/:id/complete`. */
export class CompleteAssignmentDto {
  @IsUUID()
  agentId!: UUID;

  @IsString()
  @IsNotEmpty()
  summary!: string;

  @IsArray()
  prepared!: TcpAssignmentWorkingArtifact[];
}

/** Body for `POST /internal/assignment/:id/assure`. */
export class AssureAssignmentDto {
  @IsUUID()
  agentId!: UUID;

  /** Case/whitespace-folded before validation — an LLM's `Accept`/`REJECT` shouldn't need a retry. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(['accept', 'reject'])
  qa!: 'accept' | 'reject';

  /** Required when `qa === 'reject'` — enforced in the controller. */
  @IsOptional()
  @IsString()
  feedback?: string;
}

/** Re-exported for the service's manual artifact validation. */
export type { TcpArtifact };
