import { ApiProperty } from '@nestjs/swagger';
import type { TcpAssignmentMode } from '@tcp/shared';
import type { ResolvedMaterial, StorageScope } from '../storage-scope.service';
import {
  ASSIGNMENT_MODES,
  AssignmentResponseDto,
  TaskResponseDto,
} from './entity-response.dto';

// Response shapes for the `/internal/*` routes tcp-agent and the MCP servers
// call, published as classes so the Swagger plugin can read them (it cannot
// read an interface — see knowledge-response.dto.ts).

/** Files an agent run has touched so far. */
export class StorageChangesDto {
  created!: string[];
  modified!: string[];
  deleted!: string[];
  @ApiProperty({
    type: 'array',
    items: {
      type: 'object',
      required: ['from', 'to'],
      properties: { from: { type: 'string' }, to: { type: 'string' } },
    },
  })
  moved!: { from: string; to: string }[];
}

/** `GET /internal/agent/:agentId`: the slice of the agent record other services need. */
export class InternalAgentResponseDto {
  id!: string;
  @ApiProperty({ type: StorageChangesDto, nullable: true, required: false })
  storageChanges?: StorageChangesDto | null;
}

/**
 * `POST /internal/pause`. `slug` is set for a `user_input` pause;
 * `consultationId` and `roleName` for an `agent_consultation`.
 */
export class PauseResponseDto {
  slug?: string;
  consultationId?: string;
  roleName?: string;
}

/** `GET /internal/agent/:agentId/assignment`. */
export class AgentAssignmentResponseDto {
  assignment!: AssignmentResponseDto;
  @ApiProperty({ type: TaskResponseDto, nullable: true })
  task!: TaskResponseDto | null;
}

/** {@link ResolvedMaterial}: one of an assignment's materials, resolved. */
export class ResolvedMaterialDto implements ResolvedMaterial {
  /** Stable name the model addresses the material by (`inline-N` for inline text). */
  name!: string;
  /** Full storage key, or `null` for an inline-text material. */
  @ApiProperty({ type: String, nullable: true })
  key!: string | null;
  /** Literal content, present only for inline-text materials. */
  inlineText?: string;
}

/** {@link StorageScope}: the slice of storage an agent's scoped tools may see. */
export class StorageScopeResponseDto implements StorageScope {
  @ApiProperty({ enum: ASSIGNMENT_MODES })
  mode!: TcpAssignmentMode;
  /** True for qa-mode callers — the working tools may only read. */
  readOnly!: boolean;
  /** Object-key prefix (ending in `/`) of the scoped working directory. */
  workingPrefix!: string;
  @ApiProperty({ type: ResolvedMaterialDto, isArray: true })
  materials!: ResolvedMaterialDto[];
}

/** `POST /internal/task/:taskId/plan`. */
export class PlanCreatedResponseDto {
  /** Assignments the plan created. */
  created!: number;
}
