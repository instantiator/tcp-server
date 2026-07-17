import {
  AuditEvent,
  buildTaskChangeSummary,
  formatShortcodeIndex,
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
  TaskChangeSummary,
  type LcpMaterialArtifact,
} from '@lcp/shared';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, In, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { taskMaterialsKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { claimStatus } from './claim-status';
import { CreateTaskDto, UpdateTaskDto } from './dto/task.dto';
import { TaskDispatcher } from './task-dispatcher.service';

/** Result of a materials upload — mirrors `KnowledgeService`'s `DocumentSummary` shape. */
export interface TaskMaterialSummary {
  key: string;
  name: string;
  size: number;
}

/**
 * Creates and manages {@link LcpTask} records: creation, materials upload,
 * starting (dispatch to the planner), and listing/retrieval. No plan
 * generation or assignment execution happens here — see
 * `docs/prompts/010.2.3` for this part's scope.
 */
@Injectable()
export class TaskService {
  constructor(
    @InjectRepository(LcpTask)
    private readonly taskRepo: Repository<LcpTask>,
    @InjectRepository(LcpAssignment)
    private readonly assignmentRepo: Repository<LcpAssignment>,
    @InjectRepository(LcpCompany)
    private readonly companyRepo: Repository<LcpCompany>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    private readonly storage: StorageService,
    private readonly dispatcher: TaskDispatcher,
    private readonly audit: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a task. `plannerRoleId`, when given, must belong to `companyId`.
   * @throws {@link NotFoundException} for an unknown company or planner role.
   */
  async create(dto: CreateTaskDto): Promise<LcpTask> {
    const company = await this.companyRepo.findOneBy({ id: dto.companyId });
    if (!company) {
      throw new NotFoundException(`Company ${dto.companyId} not found`);
    }
    if (dto.plannerRoleId) {
      await this.assertRoleBelongsToCompany(dto.plannerRoleId, company.id);
    }

    const task = this.taskRepo.create({
      companyId: company.id,
      shortcode: await this.nextTaskShortcode(company.id),
      request: dto.request,
      plannerRoleId: dto.plannerRoleId ?? null,
      materials: dto.materials ?? [],
      expected: dto.expected ?? [],
    });
    return this.taskRepo.save(task);
  }

  /**
   * Edits an unstarted task's `request`/`plannerRoleId`/`materials`/`expected`.
   * Only fields present in `dto` are changed.
   *
   * @throws {@link NotFoundException} for an unknown task or (when given) a
   *   `plannerRoleId` that does not belong to the task's company.
   * @throws {@link ConflictException} once the task has left `ready`.
   */
  async update(taskId: UUID, dto: UpdateTaskDto): Promise<LcpTask> {
    const task = await this.getTaskOrThrow(taskId);
    if (task.status !== 'ready') {
      throw new ConflictException(
        `Task ${taskId} is not ready (status: ${task.status}) — only unstarted tasks can be edited`,
      );
    }
    if (dto.plannerRoleId) {
      await this.assertRoleBelongsToCompany(dto.plannerRoleId, task.companyId);
    }

    await this.taskRepo.update(taskId, {
      ...(dto.request !== undefined && { request: dto.request }),
      ...(dto.plannerRoleId !== undefined && {
        plannerRoleId: dto.plannerRoleId,
      }),
      ...(dto.materials !== undefined && { materials: dto.materials }),
      ...(dto.expected !== undefined && { expected: dto.expected }),
    });
    return this.getTaskOrThrow(taskId);
  }

  /**
   * Atomically increments `company.nextTaskShortcodeIndex` and formats the
   * pre-increment value as the new task's shortcode — mirrors
   * `ConversationService.create`'s `queryIndex` increment (`UPDATE …
   * RETURNING` on PostgreSQL; a non-atomic read/update fallback for SQLite,
   * used only by e2e tests without a real PostgreSQL instance).
   */
  private async nextTaskShortcode(companyId: UUID): Promise<string> {
    let index = 0;
    if (this.dataSource.options.type === 'postgres') {
      // A non-SELECT query on the postgres driver resolves to
      // [rows, affectedRowCount], not just the rows — indexing straight into
      // the top-level result (as if it were `rows[0]`) silently reads past
      // the row array and always misses.
      const [rows] = await this.dataSource.query<
        [{ nextTaskShortcodeIndex: number }[], number]
      >(
        `UPDATE lcp_company SET "nextTaskShortcodeIndex" = "nextTaskShortcodeIndex" + 1 WHERE id = $1 RETURNING "nextTaskShortcodeIndex"`,
        [companyId],
      );
      index = (rows[0]?.nextTaskShortcodeIndex ?? 1) - 1;
    } else {
      const company = await this.companyRepo.findOneBy({ id: companyId });
      index = company?.nextTaskShortcodeIndex ?? 0;
      await this.companyRepo.update(companyId, {
        nextTaskShortcodeIndex: index + 1,
      });
    }
    return formatShortcodeIndex(index);
  }

  /** @throws {@link NotFoundException} when `roleId` does not belong to `companyId`. */
  private async assertRoleBelongsToCompany(
    roleId: UUID,
    companyId: UUID,
  ): Promise<void> {
    const role = await this.roleRepo.findOneBy({ id: roleId, companyId });
    if (!role) {
      throw new NotFoundException(
        `Role ${roleId} not found in company ${companyId}`,
      );
    }
  }

  /**
   * Uploads a task material into `tasks/{id}/materials/` and appends a
   * `task-materials-path` artifact to the task's `materials` list.
   *
   * @throws {@link NotFoundException} for an unknown task.
   * @throws {@link ConflictException} when the task is not `ready`.
   */
  async addMaterial(
    taskId: UUID,
    filename: string,
    content: Buffer,
    contentType: string,
  ): Promise<TaskMaterialSummary> {
    const task = await this.getTaskOrThrow(taskId);
    if (task.status !== 'ready') {
      throw new ConflictException(
        `Task ${taskId} is not ready (status: ${task.status})`,
      );
    }
    const company = await this.companyRepo.findOneByOrFail({
      id: task.companyId,
    });

    const key = taskMaterialsKey(company.slug, task.id, filename);
    const size = await this.storage.putByKey(key, content, contentType);

    const artifact: LcpMaterialArtifact = {
      type: 'task-materials-path',
      value: filename,
    };
    task.materials = [...task.materials, artifact];
    await this.taskRepo.save(task);

    return { key, name: filename, size };
  }

  /**
   * Starts a task: resolves a planner role (task's own, falling back to the
   * company default), atomically transitions `ready → planning`, then
   * dispatches the planner.
   *
   * @throws {@link NotFoundException} for an unknown task.
   * @throws {@link UnprocessableEntityException} when no planner role is resolvable.
   * @throws {@link ConflictException} when the task is not `ready`.
   */
  async start(taskId: UUID): Promise<LcpTask> {
    const task = await this.getTaskOrThrow(taskId);
    const company = await this.companyRepo.findOneByOrFail({
      id: task.companyId,
    });
    const plannerRoleId = task.plannerRoleId ?? company.plannerRoleId ?? null;
    if (!plannerRoleId) {
      throw new UnprocessableEntityException(
        `Task ${taskId} has no resolvable planner role — set the task's plannerRoleId or the company's default`,
      );
    }

    // Atomic conditional UPDATE (see AgentOrchestrationService.resumeAgent's
    // pausedAt claim): only the caller that actually flips ready → planning
    // proceeds to dispatch, so a double POST /start can't dispatch twice.
    const claimed = await claimStatus(
      this.taskRepo,
      taskId,
      'ready',
      'planning',
    );
    if (claimed === 0) {
      throw new ConflictException(
        `Task ${taskId} is not ready (already started, or in a terminal state)`,
      );
    }

    const started = await this.getTaskOrThrow(taskId);
    await this.dispatcher.dispatchPlanner(started);
    return started;
  }

  /**
   * Cancels a task: atomically claims a non-terminal status → `cancelled`,
   * then cascades to its still-non-terminal assignments and their working
   * agents (see {@link TaskDispatcher.cancelTask}).
   *
   * @throws {@link NotFoundException} for an unknown task.
   * @throws {@link ConflictException} when the task is already terminal
   *   (`succeeded`, `failed`, or `cancelled`).
   */
  async cancel(taskId: UUID): Promise<LcpTask> {
    await this.getTaskOrThrow(taskId);

    const claimed = await this.taskRepo
      .createQueryBuilder()
      .update(LcpTask)
      .set({ status: 'cancelled' })
      .where('id = :id', { id: taskId })
      .andWhere('status NOT IN (:...terminal)', {
        terminal: ['succeeded', 'failed', 'cancelled'],
      })
      .execute();
    if ((claimed.affected ?? 0) === 0) {
      throw new ConflictException(
        `Task ${taskId} is already in a terminal state`,
      );
    }

    const cancelled = await this.getTaskOrThrow(taskId);
    await this.dispatcher.cancelTask(cancelled);
    return cancelled;
  }

  /**
   * Lists a company's tasks, most recently created first.
   * @throws {@link NotFoundException} for an unknown company.
   */
  async list(companyId: UUID): Promise<LcpTask[]> {
    const company = await this.companyRepo.findOneBy({ id: companyId });
    if (!company) {
      throw new NotFoundException(`Company ${companyId} not found`);
    }
    return this.taskRepo.find({
      where: { companyId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Retrieves a task with its assignments, ordered: implement-mode plan
   * assignments by `orderIndex`, then the rest (plan/qa-mode) by `createdAt`.
   * @throws {@link NotFoundException} for an unknown task.
   */
  async getWithAssignments(
    taskId: UUID,
  ): Promise<{ task: LcpTask; assignments: LcpAssignment[] }> {
    const task = await this.getTaskOrThrow(taskId);
    const assignments = await this.assignmentRepo.find({
      where: { taskId },
    });
    assignments.sort((a, b) => {
      const aPlanned = a.mode === 'implement' && a.orderIndex != null;
      const bPlanned = b.mode === 'implement' && b.orderIndex != null;
      if (aPlanned && bPlanned) return a.orderIndex! - b.orderIndex!;
      if (aPlanned !== bPlanned) return aPlanned ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    });
    return { task, assignments };
  }

  /**
   * Retrieves a task's audit history: every event recorded for the agents
   * that worked its own assignments (plan, implement, qa, finalise), oldest
   * first. Consultations spawned mid-assignment inherit the task's `taskId`
   * (see {@link LcpAssignment.parentAssignmentId}), so they are included
   * automatically — no separate parent-chain walk needed.
   *
   * @throws {@link NotFoundException} for an unknown task.
   */
  async getHistory(taskId: UUID): Promise<AuditEvent[]> {
    const task = await this.getTaskOrThrow(taskId);
    const assignments = await this.assignmentRepo.find({ where: { taskId } });
    const agentIds = assignments
      .map((a) => a.agentId)
      .filter((id): id is UUID => Boolean(id));
    return this.audit.list(task.companyId, agentIds);
  }

  /** Builds a single task's {@link TaskChangeSummary} — used to prime `GET /api/task/:id/events`. */
  async getChangeSummary(taskId: UUID): Promise<TaskChangeSummary> {
    const task = await this.getTaskOrThrow(taskId);
    const plan = await this.assignmentRepo.find({
      where: { taskId, mode: 'implement' },
    });
    return buildTaskChangeSummary(task, plan);
  }

  /**
   * Builds every current task's {@link TaskChangeSummary} for a company —
   * used to prime `GET /api/company/:id/events` with its Tasks list.
   */
  async listChangeSummaries(companyId: UUID): Promise<TaskChangeSummary[]> {
    const tasks = await this.list(companyId);
    if (tasks.length === 0) return [];
    const plan = await this.assignmentRepo.find({
      where: { taskId: In(tasks.map((t) => t.id)), mode: 'implement' },
    });
    const byTask = new Map<UUID, LcpAssignment[]>();
    for (const assignment of plan) {
      const list = byTask.get(assignment.taskId!) ?? [];
      list.push(assignment);
      byTask.set(assignment.taskId!, list);
    }
    return tasks.map((task) =>
      buildTaskChangeSummary(task, byTask.get(task.id) ?? []),
    );
  }

  private async getTaskOrThrow(taskId: UUID): Promise<LcpTask> {
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    return task;
  }
}
