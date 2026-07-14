import type { UUID } from 'crypto';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import type {
  LcpArtifact,
  LcpAssignmentWorkingArtifact,
  LcpMaterialArtifact,
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
  expected: LcpAssignmentWorkingArtifact[];
  materials?: LcpMaterialArtifact[];
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
  prepared!: LcpAssignmentWorkingArtifact[];
}

/** Body for `POST /internal/assignment/:id/assure`. */
export class AssureAssignmentDto {
  @IsUUID()
  agentId!: UUID;

  @IsIn(['accept', 'reject'])
  qa!: 'accept' | 'reject';

  /** Required when `qa === 'reject'` — enforced in the controller. */
  @IsOptional()
  @IsString()
  feedback?: string;
}

/** Re-exported for the service's manual artifact validation. */
export type { LcpArtifact };
