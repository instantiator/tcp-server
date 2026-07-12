import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { InternalApiKeyGuard, LcpAssignment, LcpTask } from '@lcp/shared';
import type { UUID } from 'crypto';
import { AssignmentService } from './assignment.service';
import {
  AssureAssignmentDto,
  CompleteAssignmentDto,
  PlanTaskDto,
} from './dto/internal-task.dto';

/**
 * Internal service-to-service endpoints backing the lcp-mcp-tasks MCP tools.
 * All routes are protected by {@link InternalApiKeyGuard} and called only by
 * lcp-mcp-tasks, which resolves the caller's identity server-side (the model
 * never supplies an agent/assignment/task id — see `docs/prompts/010.2.5`).
 */
@ApiTags('internal')
@ApiSecurity('internal-api-key')
@Controller('internal')
@UseGuards(InternalApiKeyGuard)
export class InternalTaskController {
  constructor(private readonly assignments: AssignmentService) {}

  /**
   * Returns the caller agent's assignment (and its task, when present) — the
   * MCP tool handlers use this to mode-gate each tool.
   */
  @ApiOperation({ summary: "Get an agent's assignment (internal)" })
  @Get('agent/:agentId/assignment')
  async getAssignment(
    @Param('agentId') agentId: UUID,
  ): Promise<{ assignment: LcpAssignment; task: LcpTask | null }> {
    return this.assignments.getAgentAssignment(agentId);
  }

  /** Creates a task's plan from a planning agent's `create_plan` call. */
  @ApiOperation({ summary: 'Create a task plan (internal)' })
  @Post('task/:taskId/plan')
  @HttpCode(201)
  async planTask(
    @Param('taskId') taskId: UUID,
    @Body() body: PlanTaskDto,
  ): Promise<{ created: number }> {
    return this.assignments.planTask(taskId, body.agentId, body.assignments);
  }

  /** Completes an implement-mode assignment (`complete_assignment`). */
  @ApiOperation({ summary: 'Complete an assignment (internal)' })
  @Post('assignment/:id/complete')
  @HttpCode(200)
  async complete(
    @Param('id') id: UUID,
    @Body() body: CompleteAssignmentDto,
  ): Promise<void> {
    await this.assignments.completeAssignment(
      id,
      body.agentId,
      body.summary,
      body.prepared,
    );
  }

  /** Records a QA verdict on an assignment (`assure_assignment`). */
  @ApiOperation({ summary: 'Assure an assignment (internal)' })
  @Post('assignment/:id/assure')
  @HttpCode(200)
  async assure(
    @Param('id') id: UUID,
    @Body() body: AssureAssignmentDto,
  ): Promise<void> {
    if (body.qa === 'reject' && !body.feedback?.trim()) {
      throw new BadRequestException(
        'feedback is required when rejecting an assignment.',
      );
    }
    await this.assignments.assureAssignment(
      id,
      body.agentId,
      body.qa,
      body.feedback,
    );
  }
}
