import {
  buildAssignmentShortcode,
  TcpAgent,
  TcpAssignment,
  TcpAssignmentWorkingArtifact,
  TcpTask,
  stripControlChars,
} from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AssignmentCompletionService } from './assignment-completion.service';
import { claimStatus } from './claim-status';
import { PauseAndResumeService } from './pause-and-resume.service';
import { PlanValidationService } from './plan-validation.service';
import { StorageScope, StorageScopeService } from './storage-scope.service';
import { TaskDispatcher } from './task-dispatcher.service';
import type { PlanAssignmentInput } from './dto/internal-task.dto';

/**
 * The validated state transitions backing the tcp-mcp-tasks MCP tools
 * (`create_plan`, `complete_assignment`, `assure_assignment`). tcp-server owns
 * the DB and {@link StorageService}, so all transitions live here; the MCP
 * service is a thin proxy (mirrors how `tcp-mcp-storage`/`tcp-mcp-interactions`
 * relate to their tcp-server endpoints). Completion lives in
 * {@link AssignmentCompletionService}, plan validation in
 * {@link PlanValidationService}, and storage scoping in
 * {@link StorageScopeService}.
 *
 * Every transition uses an atomic conditional UPDATE (the `pausedAt` claim
 * pattern in `AgentOrchestrationService`) so concurrent/double calls resolve to
 * a single winner; the loser gets a descriptive {@link ConflictException}.
 * Orchestration *reactions* (dispatching QA, resuming after rejection, copying
 * approved files, advancing the plan) belong to the {@link TaskDispatcher}
 * hooks called at the end of each transition.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    private readonly dispatcher: TaskDispatcher,
    private readonly pauseResume: PauseAndResumeService,
    private readonly completion: AssignmentCompletionService,
    private readonly planValidation: PlanValidationService,
    private readonly scopes: StorageScopeService,
  ) {}

  /**
   * Returns the caller agent's assignment (and its task, when it has one).
   * Used by the MCP tool handlers to mode-gate each tool, and by part 6 for
   * storage scoping.
   *
   * @throws {@link NotFoundException} when the agent (or its assignment) is absent.
   */
  async getAgentAssignment(
    agentId: UUID,
  ): Promise<{ assignment: TcpAssignment; task: TcpTask | null }> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    const assignment = await this.assignmentRepo.findOneBy({
      id: agent.assignmentId,
    });
    if (!assignment) {
      throw new NotFoundException(
        `Agent ${agentId} has no assignment ${agent.assignmentId}`,
      );
    }
    const task = assignment.taskId
      ? await this.taskRepo.findOneBy({ id: assignment.taskId })
      : null;
    return { assignment, task };
  }

  /**
   * Resolves the {@link StorageScope} the agent's scoped storage tools operate
   * on — see {@link StorageScopeService.resolve}.
   */
  async resolveStorageScope(agentId: UUID): Promise<StorageScope> {
    const { assignment } = await this.getAgentAssignment(agentId);
    return this.scopes.resolve(assignment);
  }

  /**
   * Turns a task into its plan: validates the caller is a `plan`-mode agent
   * working `taskId` and that the proposed plan is sound, atomically claims the
   * task `planning → in-progress`, and creates the ordered implement-mode
   * assignment rows.
   *
   * @returns the created assignment count.
   */
  async planTask(
    taskId: UUID,
    agentId: UUID,
    assignments: PlanAssignmentInput[],
  ): Promise<{ created: number }> {
    const { assignment: caller } = await this.getAgentAssignment(agentId);
    if (caller.mode !== 'plan') {
      throw new BadRequestException(
        `You are not in plan mode; only a planning agent can create a plan.`,
      );
    }
    if (caller.taskId !== taskId) {
      throw new BadRequestException(
        `Your assignment does not belong to task ${taskId}.`,
      );
    }
    const task = await this.taskRepo.findOneByOrFail({ id: taskId });

    // Nothing is created unless the whole plan validates.
    const plan = await this.planValidation.validate(
      caller.companyId,
      assignments,
    );

    // Atomic claim: only the caller that flips planning → in-progress creates
    // the plan, so a double create_plan can't produce two sets of rows.
    const claim = await claimStatus(
      this.taskRepo,
      taskId,
      'planning',
      'in-progress',
    );
    if (claim === 0) {
      throw new ConflictException(
        `Task ${taskId} is not awaiting a plan (already planned, or in a terminal state).`,
      );
    }

    for (const [i, a] of assignments.entries()) {
      await this.assignmentRepo.save(
        this.assignmentRepo.create({
          taskId,
          companyId: caller.companyId,
          mode: 'implement',
          orderIndex: i,
          shortcode: buildAssignmentShortcode(
            task.shortcode,
            'implement',
            i + 1,
          ),
          prompt: a.prompt,
          roleId: plan.roleIds[i],
          status: 'ready',
          materials: plan.materialsByIndex[i],
          expected: plan.expectedByIndex[i],
        }),
      );
    }

    // Planning is done: `create_plan` IS the planner's completion (like
    // `complete_assignment` is an implementer's). Mark the plan assignment
    // succeeded and complete the planner agent so its worker run ends now — the
    // supervised loop detects the terminal status on its next check and exits,
    // instead of looping to `max_iterations` and needlessly hogging the model.
    await this.assignmentRepo.update(caller.id, { status: 'succeeded' });
    await this.pauseResume.completeAgent(
      agentId,
      `Plan created: ${assignments.length} assignment(s).`,
    );

    await this.dispatcher.taskPlanned(task);
    this.logger.log(
      `Task ${taskId} planned by agent ${agentId}: ${assignments.length} assignment(s)`,
    );
    return { created: assignments.length };
  }

  /**
   * Completes an implement-, consultee- or finalise-mode assignment — see
   * {@link AssignmentCompletionService.complete}.
   */
  async completeAssignment(
    assignmentId: UUID,
    agentId: UUID,
    summary: string,
    prepared: TcpAssignmentWorkingArtifact[],
  ): Promise<void> {
    const assignment = await this.loadAssignment(assignmentId);
    await this.completion.complete(assignment, agentId, summary, prepared);
  }

  /**
   * Records a QA verdict on the assignment under review, then completes the QA
   * agent. The accept/reject consequences are the dispatcher's
   * ({@link TaskDispatcher.assignmentAssured}).
   *
   * @throws {@link ForbiddenException} when the caller isn't the QA agent for `id`.
   * @throws {@link ConflictException} (409) when the target isn't awaiting QA.
   */
  async assureAssignment(
    targetAssignmentId: UUID,
    agentId: UUID,
    qa: 'accept' | 'reject',
    feedback: string | undefined,
  ): Promise<void> {
    const { assignment: caller } = await this.getAgentAssignment(agentId);
    if (caller.mode !== 'qa') {
      throw new BadRequestException(
        `You are not in QA mode; only a QA agent can assure an assignment.`,
      );
    }
    if (caller.targetAssignmentId !== targetAssignmentId) {
      throw new ForbiddenException(
        `Your QA assignment does not target assignment ${targetAssignmentId}.`,
      );
    }
    const target = await this.loadAssignment(targetAssignmentId);
    if (target.status !== 'in-qa') {
      throw new ConflictException(
        `Assignment ${targetAssignmentId} is not in QA (status: ${target.status}).`,
      );
    }

    const qaStatus = qa === 'accept' ? 'accepted' : 'rejected';
    // Strip stray control chars from the model's feedback so stored JSON stays
    // valid for strict parsers.
    const cleanFeedback = feedback ? stripControlChars(feedback) : null;
    // Atomic claim: only the first assure with status still `in-qa` and no
    // verdict yet wins; a duplicate gets a 409.
    const claim = await this.assignmentRepo
      .createQueryBuilder()
      .update(TcpAssignment)
      .set({ qaStatus, qaFeedback: cleanFeedback })
      .where('id = :id', { id: targetAssignmentId })
      .andWhere('status = :inQa', { inQa: 'in-qa' })
      .andWhere('qaStatus IS NULL')
      .execute();
    if (claim.affected === 0) {
      throw new ConflictException(
        `Assignment ${targetAssignmentId} has already been assured.`,
      );
    }

    await this.dispatcher.assignmentAssured(target);

    // The QA agent's own assignment is done; its output is the verdict.
    const verdict =
      qa === 'accept'
        ? 'Accepted.'
        : `Rejected: ${feedback ?? 'no feedback given'}`;
    caller.status = 'succeeded';
    caller.summary = verdict;
    await this.assignmentRepo.save(caller);
    await this.pauseResume.completeAgent(agentId, verdict);
    this.logger.log(
      `Assignment ${targetAssignmentId} assured (${qaStatus}) by agent ${agentId}`,
    );
  }

  private async loadAssignment(id: UUID): Promise<TcpAssignment> {
    const assignment = await this.assignmentRepo.findOneBy({ id });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${id} not found`);
    }
    return assignment;
  }
}
