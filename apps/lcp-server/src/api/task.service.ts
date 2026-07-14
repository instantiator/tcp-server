import {
  LcpAssignment,
  LcpCompany,
  LcpRole,
  LcpTask,
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
import { Repository } from 'typeorm';
import { taskMaterialsKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { CreateTaskDto } from './dto/task.dto';
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
      const role = await this.roleRepo.findOneBy({
        id: dto.plannerRoleId,
        companyId: company.id,
      });
      if (!role) {
        throw new NotFoundException(
          `Role ${dto.plannerRoleId} not found in company ${company.id}`,
        );
      }
    }

    const task = this.taskRepo.create({
      companyId: company.id,
      request: dto.request,
      plannerRoleId: dto.plannerRoleId ?? null,
      materials: dto.materials ?? [],
      expected: dto.expected ?? [],
    });
    return this.taskRepo.save(task);
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
    const result = await this.taskRepo
      .createQueryBuilder()
      .update(LcpTask)
      .set({ status: 'planning' })
      .where('id = :id', { id: taskId })
      .andWhere('status = :ready', { ready: 'ready' })
      .execute();
    if (result.affected === 0) {
      throw new ConflictException(
        `Task ${taskId} is not ready (already started, or in a terminal state)`,
      );
    }

    const started = await this.getTaskOrThrow(taskId);
    await this.dispatcher.dispatchPlanner(started);
    return started;
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

  private async getTaskOrThrow(taskId: UUID): Promise<LcpTask> {
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) throw new NotFoundException(`Task ${taskId} not found`);
    return task;
  }
}
