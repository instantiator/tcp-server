import {
  AuditEventType,
  buildAssignmentChangeSummary,
  type AuditEvent,
  type TcpTask,
  type WireEvent,
} from '@tcp/shared';
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
  ApiAcceptedResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { TaskMaterialResponseDto } from './dto/storage-response.dto';
import type { UUID } from 'crypto';
import { defer, from, merge, mergeMap, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CompanyMembershipGuard } from '../auth/company-membership.guard';
import {
  CompanyScope,
  CompanyScopeRequired,
} from '../auth/company-scope.decorator';
import { TaskEventService } from '../events/task-event.service';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto';
import {
  AuditEventResponseDto,
  TaskDetailResponseDto,
  TaskResponseDto,
} from './dto/entity-response.dto';
import { ResumeResultDto } from './dto/spend.dto';
import { ResumeResult, SpendResumeService } from './spend-resume.service';
import { SystemShutdownService } from './system-shutdown.service';
import { TaskMaterialSummary, TaskService } from './task.service';

/** Subset of the multer file object relevant to a materials upload. */
interface UploadedFileBuffer {
  originalname: string;
  buffer: Buffer;
  mimetype?: string;
}

/** REST controller for {@link TcpTask} create, materials upload, start, list, and get. */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyMembershipGuard)
@Controller({ path: 'api/task' })
export class TaskController {
  constructor(
    private readonly tasks: TaskService,
    private readonly taskEvents: TaskEventService,
    private readonly shutdown: SystemShutdownService,
    private readonly spend: SpendResumeService,
  ) {}

  /** Creates a task in the `ready` state. No plan is generated until `POST /api/task/:id/start`. */
  @ApiOperation({ summary: 'Create a task' })
  @ApiCreatedResponse({ type: TaskResponseDto })
  @CompanyScope({ from: 'body', key: 'companyId', via: 'company' })
  @Post()
  async createTask(@Body() body: CreateTaskDto): Promise<TcpTask> {
    return this.tasks.create(body);
  }

  /**
   * Edits an unstarted task's `request`/`plannerRoleId`/`materials`/`expected`.
   * `id`, `companyId`, `status`, `completed`, and `failureReason` are not
   * editable.
   */
  @ApiOperation({ summary: 'Partially update an unstarted task' })
  @ApiOkResponse({ type: TaskResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
  @Put(':id')
  async updateTask(
    @Param('id') id: UUID,
    @Body() body: UpdateTaskDto,
  ): Promise<TcpTask> {
    return this.tasks.update(id, body);
  }

  /**
   * Uploads a task material (field `file`). Rejected once the task has left
   * the `ready` state.
   */
  @ApiOperation({ summary: 'Upload a task material' })
  @ApiConsumes('multipart/form-data')
  // `@ApiConsumes` alone names the encoding and describes no body, so the
  // route generates into the client's `schema.d.ts` as `requestBody?: never`
  // and no typed caller can upload to it. The shape is declared by hand
  // because the file arrives through `FileInterceptor`, not through a DTO the
  // Swagger plugin could read.
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
  @ApiCreatedResponse({ type: TaskMaterialResponseDto })
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
   *
   * Refused with `503` while the system is draining for shutdown.
   */
  @ApiOperation({ summary: 'Start a task' })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
  @Post(':id/start')
  @HttpCode(202)
  async startTask(@Param('id') id: UUID): Promise<TcpTask> {
    this.shutdown.assertAccepting();
    await this.spend.exemptIfCapped(id);
    return this.tasks.start(id);
  }

  /**
   * Resumes a task's agents paused by a spend cap or a shutdown, and exempts
   * the task from spend caps until it ends — resuming is the user choosing to
   * spend. Refused with `503` while the system is draining.
   */
  @ApiOperation({ summary: 'Resume a paused task' })
  @ApiAcceptedResponse({ type: ResumeResultDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
  @Post(':id/resume')
  @HttpCode(202)
  resumeTask(@Param('id') id: UUID): Promise<ResumeResult> {
    return this.spend.resumeTask(id);
  }

  /**
   * Cancels a task: transitions any non-terminal status → `cancelled` and
   * cascades to its still-non-terminal assignments and their working agents.
   */
  @ApiOperation({ summary: 'Cancel a task' })
  @ApiAcceptedResponse({ type: TaskResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
  @Post(':id/cancel')
  @HttpCode(202)
  async cancelTask(@Param('id') id: UUID): Promise<TcpTask> {
    return this.tasks.cancel(id);
  }

  /** Lists a company's tasks. */
  @ApiOperation({ summary: 'List tasks for a company' })
  @ApiOkResponse({ type: TaskResponseDto, isArray: true })
  @CompanyScope({ from: 'query', key: 'companyId', via: 'company' })
  @CompanyScopeRequired('companyId query parameter is required')
  @Get()
  async listTasks(@Query('companyId') companyId?: UUID): Promise<TcpTask[]> {
    if (!companyId) {
      throw new BadRequestException('companyId query parameter is required');
    }
    return this.tasks.list(companyId);
  }

  /**
   * Retrieves a task with the assignments working it.
   *
   * The task's own fields are at the top level and `assignments` sits beside
   * them, rather than the `{ task, assignments }` wrapper this returned before
   * 007.02. A wrapper has no top-level `id`, and the browser patches a cached
   * entity from a live event by matching `id` — so a wrapper cannot be updated
   * by an event at all (ADR-030). The flattening belongs here rather than in
   * {@link TaskService.getWithAssignments}, which is about persistence.
   */
  @ApiOperation({ summary: 'Get a task by ID' })
  @ApiOkResponse({ type: TaskDetailResponseDto })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
  @Get(':id')
  async getTask(@Param('id') id: UUID): Promise<TaskDetailResponseDto> {
    const { task, assignments } = await this.tasks.getWithAssignments(id);
    return { ...task, assignments };
  }

  /**
   * Retrieves a task's audit history — every event recorded for the agents
   * that worked its own plan/implement/qa/finalise assignments (including
   * consultations spawned mid-assignment), oldest first — see
   * {@link TaskService.getHistory}.
   */
  @ApiOperation({ summary: "Get a task's audit history" })
  @ApiOkResponse({ type: AuditEventResponseDto, isArray: true })
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
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
  @CompanyScope({ from: 'param', key: 'id', via: 'task' })
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
