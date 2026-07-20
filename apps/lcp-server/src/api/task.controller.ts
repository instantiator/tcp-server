import {
  AuditEventType,
  buildAssignmentChangeSummary,
  type AuditEvent,
  type LcpAssignment,
  type LcpTask,
  type WireEvent,
} from '@lcp/shared';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  MessageEvent,
  Param,
  Post,
  Put,
  Query,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { UUID } from 'crypto';
import { defer, from, merge, mergeMap, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { TaskEventService } from '../events/task-event.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto';
import { TaskMaterialSummary, TaskService } from './task.service';

/** Subset of the multer file object relevant to a materials upload. */
interface UploadedFileBuffer {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

/** REST controller for {@link LcpTask} create, materials upload, start, list, and get. */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller({ path: 'api/task' })
export class TaskController {
  constructor(
    private readonly tasks: TaskService,
    private readonly taskEvents: TaskEventService,
  ) {}

  /** Creates a task in the `ready` state. No plan is generated until `POST /api/task/:id/start`. */
  @ApiOperation({ summary: 'Create a task' })
  @Post()
  async createTask(@Body() body: CreateTaskDto): Promise<LcpTask> {
    return this.tasks.create(body);
  }

  /**
   * Edits an unstarted task's `request`/`plannerRoleId`/`materials`/`expected`.
   * `id`, `companyId`, `status`, `completed`, and `failureReason` are not
   * editable.
   */
  @ApiOperation({ summary: 'Partially update an unstarted task' })
  @Put(':id')
  async updateTask(
    @Param('id') id: UUID,
    @Body() body: UpdateTaskDto,
  ): Promise<LcpTask> {
    return this.tasks.update(id, body);
  }

  /**
   * Uploads a task material (field `file`). Rejected once the task has left
   * the `ready` state.
   */
  @ApiOperation({ summary: 'Upload a task material' })
  @ApiConsumes('multipart/form-data')
  @Post(':id/materials')
  @UseInterceptors(FileInterceptor('file'))
  async uploadMaterial(
    @Param('id') id: UUID,
    @UploadedFile() file: UploadedFileBuffer,
  ): Promise<TaskMaterialSummary> {
    return this.tasks.addMaterial(
      id,
      file.originalname,
      file.buffer,
      file.mimetype ?? 'application/octet-stream',
    );
  }

  /**
   * Starts a task: transitions `ready → planning` and dispatches the planner
   * agent (a logged no-op until `docs/prompts/010.2.7`).
   */
  @ApiOperation({ summary: 'Start a task' })
  @Post(':id/start')
  @HttpCode(202)
  async startTask(@Param('id') id: UUID): Promise<LcpTask> {
    return this.tasks.start(id);
  }

  /**
   * Cancels a task: transitions any non-terminal status → `cancelled` and
   * cascades to its still-non-terminal assignments and their working agents.
   */
  @ApiOperation({ summary: 'Cancel a task' })
  @Post(':id/cancel')
  @HttpCode(202)
  async cancelTask(@Param('id') id: UUID): Promise<LcpTask> {
    return this.tasks.cancel(id);
  }

  /** Lists a company's tasks. */
  @ApiOperation({ summary: 'List tasks for a company' })
  @Get()
  async listTasks(@Query('companyId') companyId?: UUID): Promise<LcpTask[]> {
    if (!companyId) {
      throw new BadRequestException('companyId query parameter is required');
    }
    return this.tasks.list(companyId);
  }

  /** Retrieves a task with its assignments. */
  @ApiOperation({ summary: 'Get a task by ID' })
  @Get(':id')
  async getTask(
    @Param('id') id: UUID,
  ): Promise<{ task: LcpTask; assignments: LcpAssignment[] }> {
    return this.tasks.getWithAssignments(id);
  }

  /**
   * Retrieves a task's audit history — every event recorded for the agents
   * that worked its own plan/implement/qa/finalise assignments (including
   * consultations spawned mid-assignment), oldest first — see
   * {@link TaskService.getHistory}.
   */
  @ApiOperation({ summary: "Get a task's audit history" })
  @Get(':id/history')
  async getTaskHistory(@Param('id') id: UUID): Promise<AuditEvent[]> {
    return this.tasks.getHistory(id);
  }

  /**
   * SSE stream of `task_changed`/`assignment_changed` events for this task
   * and its assignments. Primed with the task's current state (and each of
   * its assignments') so a client that subscribes late renders immediately,
   * then live updates via {@link TaskEventService}.
   */
  @ApiOperation({ summary: "Stream a task's and its assignments' events" })
  @Sse(':id/events')
  streamTaskEvents(@Param('id') id: UUID): Observable<MessageEvent> {
    const replay$ = defer(() => from(this.primeTaskEvents(id))).pipe(
      mergeMap((events) => from(events)),
    );
    return merge(replay$, this.taskEvents.observe(id)).pipe(
      map((event) => ({ data: event })),
    );
  }

  /**
   * Builds the priming {@link WireEvent}s for {@link streamTaskEvents}: the
   * task's current state, then each assignment's — synthesized `state_change`
   * rows (`reason:'replay'`, no persisted id) with the same summaries the live
   * path publishes.
   */
  private async primeTaskEvents(taskId: UUID): Promise<WireEvent[]> {
    const timestamp = new Date().toISOString();
    const { task, assignments } = await this.tasks.getWithAssignments(taskId);
    const summary = await this.tasks.getChangeSummary(taskId);
    return [
      {
        type: 'audit',
        event: {
          timestamp,
          companyId: task.companyId,
          role: 'orchestrator',
          agentId: null,
          assignmentId: null,
          taskId,
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'task',
            newStatus: task.status,
            reason: 'replay',
            summary,
          },
        },
      },
      ...assignments.map((assignment): WireEvent => ({
        type: 'audit',
        event: {
          timestamp,
          companyId: assignment.companyId,
          role: 'orchestrator',
          agentId: null,
          assignmentId: assignment.id,
          taskId,
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'assignment',
            newStatus: assignment.status,
            reason: 'replay',
            summary: buildAssignmentChangeSummary(assignment),
          },
        },
      })),
    ];
  }
}
