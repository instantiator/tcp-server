import {
  AgentStatus,
  deriveTaskStatus,
  LcpAgent,
  LcpArtifact,
  LcpAssignment,
  LcpAssignmentStatus,
  LcpAssignmentWorkingArtifact,
  LcpTask,
  resolveArtifactKey,
} from '@lcp/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { StorageService } from '../storage/storage.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';
import type { PlanAssignmentInput } from './dto/internal-task.dto';

/** Artifact types permitted in an assignment's `expected`/`prepared` lists. */
const WORKING_ARTIFACT_TYPES = new Set([
  'assignment-working-path',
  'inline-text',
]);
/** Artifact types permitted in an assignment's `materials` list. */
const MATERIAL_ARTIFACT_TYPES = new Set([
  'task-materials-path',
  'assignment-completed-path',
  'inline-text',
]);

/**
 * The validated state transitions backing the lcp-mcp-tasks MCP tools
 * (`create_plan`, `complete_assignment`, `assure_assignment`). lcp-server owns
 * the DB and {@link StorageService}, so all transitions and the completion
 * output-gate live here; the MCP service is a thin proxy (mirrors how
 * `lcp-mcp-storage`/`lcp-mcp-interactions` relate to their lcp-server
 * endpoints).
 *
 * Every transition uses an atomic conditional UPDATE (the `pausedAt` claim
 * pattern in `AgentOrchestrationService`) so concurrent/double calls resolve to
 * a single winner; the loser gets a descriptive {@link ConflictException}.
 * Orchestration *reactions* (dispatching QA, resuming after rejection, copying
 * approved files, advancing the plan) are task-orchestration part 7 — here the
 * {@link TaskDispatcher} hooks are logged no-ops.
 */
@Injectable()
export class AssignmentService {
  private readonly logger = new Logger(AssignmentService.name);

  constructor(
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpAssignment)
    private readonly assignmentRepo: Repository<LcpAssignment>,
    @InjectRepository(LcpTask)
    private readonly taskRepo: Repository<LcpTask>,
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly dispatcher: TaskDispatcher,
    private readonly pauseResume: PauseAndResumeService,
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
  ): Promise<{ assignment: LcpAssignment; task: LcpTask | null }> {
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
   * Turns a task into its plan: validates the caller is a `plan`-mode agent
   * working `taskId`, atomically claims the task `planning → in-progress`, and
   * creates the ordered implement-mode assignment rows. Reaction (dispatching
   * the first assignment) is part 7 — {@link TaskDispatcher.taskPlanned} is a
   * no-op here.
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

    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw new BadRequestException(
        'A plan must contain at least one assignment.',
      );
    }

    // Resolve every role and validate every artifact up front so the whole
    // plan is rejected atomically (nothing is created on any failure).
    const roleIds: UUID[] = [];
    for (const [i, a] of assignments.entries()) {
      if (!a.prompt || !a.prompt.trim()) {
        throw new BadRequestException(`Assignment ${i}: prompt is required.`);
      }
      if (!a.role || !a.role.trim()) {
        throw new BadRequestException(`Assignment ${i}: role is required.`);
      }
      const role = await this.db.findRoleByIdOrSlug(caller.companyId, a.role);
      if (!role) {
        throw new BadRequestException(
          `Assignment ${i}: role '${a.role}' does not exist in this company.`,
        );
      }
      roleIds.push(role.id);
      this.assertArtifactTypes(
        i,
        'expected',
        a.expected ?? [],
        WORKING_ARTIFACT_TYPES,
      );
      this.assertArtifactTypes(
        i,
        'materials',
        a.materials ?? [],
        MATERIAL_ARTIFACT_TYPES,
      );
    }

    // Atomic claim: only the caller that flips planning → in-progress creates
    // the plan, so a double create_plan can't produce two sets of rows.
    const claim = await this.taskRepo
      .createQueryBuilder()
      .update(LcpTask)
      .set({ status: 'in-progress' })
      .where('id = :id', { id: taskId })
      .andWhere('status = :planning', { planning: 'planning' })
      .execute();
    if (claim.affected === 0) {
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
          prompt: a.prompt,
          roleId: roleIds[i],
          status: 'ready',
          materials: a.materials ?? [],
          expected: a.expected ?? [],
        }),
      );
    }

    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (task) await this.dispatcher.taskPlanned(task);
    this.logger.log(
      `Task ${taskId} planned by agent ${agentId}: ${assignments.length} assignment(s)`,
    );
    return { created: assignments.length };
  }

  /**
   * Completes an implement-mode assignment: validates the caller and that the
   * prepared artifacts satisfy the assignment's expected outputs (the
   * mechanical gate), then transitions.
   *
   * - Orphan assignment (`taskId === null`): `in-progress → succeeded` and the
   *   agent is completed via the same path as `/internal/agent/:id/complete`,
   *   so consultations/conversations resolve exactly as before.
   * - Task assignment: records `prepared`/`summary`, `in-progress → in-qa`,
   *   pauses the agent (so part 7 can resume it with QA feedback), and calls
   *   {@link TaskDispatcher.assignmentReadyForQa} (no-op here).
   *
   * @throws {@link UnprocessableEntityException} (422) on a gate failure, with a
   *   corrective message the MCP layer relays to the agent.
   * @throws {@link ConflictException} (409) when the assignment is no longer
   *   `in-progress` (a concurrent/duplicate completion won).
   */
  async completeAssignment(
    assignmentId: UUID,
    agentId: UUID,
    summary: string,
    prepared: LcpAssignmentWorkingArtifact[],
  ): Promise<void> {
    const assignment = await this.loadAssignment(assignmentId);
    if (assignment.agentId !== agentId) {
      throw new ForbiddenException(
        `Agent ${agentId} is not the agent assigned to ${assignmentId}.`,
      );
    }
    if (assignment.mode !== 'implement') {
      throw new BadRequestException(
        `complete_assignment is only valid for implement-mode assignments.`,
      );
    }
    if (assignment.status !== 'in-progress') {
      throw new ConflictException(
        `Assignment ${assignmentId} is not in-progress (status: ${assignment.status}).`,
      );
    }

    this.assertArtifactTypes(0, 'prepared', prepared, WORKING_ARTIFACT_TYPES);

    const gate = await this.checkOutputGate(assignment, prepared);
    if (gate.length > 0) {
      throw new UnprocessableEntityException(this.buildGateMessage(gate));
    }

    if (assignment.taskId === null || assignment.taskId === undefined) {
      // Orphan: the prepared work is immediately final (there is no QA cycle).
      const claim = await this.claimStatus(
        assignmentId,
        'in-progress',
        'succeeded',
      );
      if (claim === 0) {
        throw new ConflictException(
          `Assignment ${assignmentId} was already completed.`,
        );
      }
      assignment.prepared = prepared;
      assignment.summary = summary;
      assignment.status = 'succeeded';
      await this.assignmentRepo.save(assignment);
      // Same completion path as complete_task used to take — resolves any
      // pending consultation/conversation for this agent.
      await this.pauseResume.completeAgent(agentId, summary);
      this.logger.log(`Orphan assignment ${assignmentId} completed`);
      return;
    }

    // Task assignment: hand off to QA. Record prepared/summary, pause the
    // agent so part 7 can resume it with the QA verdict.
    const claim = await this.claimStatus(assignmentId, 'in-progress', 'in-qa');
    if (claim === 0) {
      throw new ConflictException(
        `Assignment ${assignmentId} was already handed to QA.`,
      );
    }
    assignment.prepared = prepared;
    assignment.summary = summary;
    assignment.status = 'in-qa';
    await this.assignmentRepo.save(assignment);

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
    });

    await this.dispatcher.assignmentReadyForQa(assignment);
    await this.recomputeTaskStatus(assignment.taskId);
    this.logger.log(`Assignment ${assignmentId} handed to QA`);
  }

  /**
   * Records a QA verdict on the assignment under review, completes the QA
   * agent, and calls {@link TaskDispatcher.assignmentAssured} (no-op here —
   * part 7 owns the accept/reject consequences).
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
    // Atomic claim: only the first assure with status still `in-qa` and no
    // verdict yet wins; a duplicate gets a 409.
    const claim = await this.assignmentRepo
      .createQueryBuilder()
      .update(LcpAssignment)
      .set({ qaStatus, qaFeedback: feedback ?? null })
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

  /**
   * The mechanical output gate: returns the list of unmet requirements (empty
   * when the prepared artifacts satisfy the assignment's expected outputs).
   *
   * - each expected `assignment-working-path` must appear in `prepared` and its
   *   resolved storage key must exist;
   * - each expected `inline-text` must be matched by a prepared `inline-text`
   *   (empty expected value → any; otherwise the expected value is a regex the
   *   prepared text must match);
   * - each prepared `assignment-working-path` must exist in storage.
   */
  private async checkOutputGate(
    assignment: LcpAssignment,
    prepared: LcpAssignmentWorkingArtifact[],
  ): Promise<string[]> {
    const problems: string[] = [];
    const company = await this.db.getCompany(assignment.companyId);
    if (!company) {
      // No slug means no key resolution is possible — fail closed.
      return [`Company ${assignment.companyId} not found.`];
    }
    const ctx = {
      companySlug: company.slug,
      task: assignment.taskId ? { id: assignment.taskId } : null,
      assignment: {
        id: assignment.id,
        taskId: assignment.taskId ?? null,
        orderIndex: assignment.orderIndex ?? null,
      },
    };

    const preparedPaths = prepared.filter(
      (p) => p.type === 'assignment-working-path',
    );
    const preparedInline = prepared.filter((p) => p.type === 'inline-text');

    // Expected coverage.
    for (const exp of assignment.expected) {
      if (exp.type === 'assignment-working-path') {
        if (!preparedPaths.some((p) => p.value === exp.value)) {
          problems.push(`Expected file '${exp.value}' was not provided.`);
        }
      } else if (exp.type === 'inline-text') {
        const matched = preparedInline.some((p) =>
          this.inlineMatches(exp.value, p.value),
        );
        if (!matched) {
          problems.push(
            exp.value
              ? `Expected inline text matching /${exp.value}/ was not provided.`
              : `Expected inline text was not provided.`,
          );
        }
      }
    }

    // Every prepared file must exist in storage.
    const keys: string[] = [];
    for (const p of preparedPaths) {
      const key = resolveArtifactKey(p, ctx);
      if (key) keys.push(key);
    }
    if (keys.length > 0) {
      const missing = await this.storage.checkMissingFiles(keys);
      // Map missing keys back to the artifact values for a friendlier message.
      for (const p of preparedPaths) {
        const key = resolveArtifactKey(p, ctx);
        if (key && missing.includes(key)) {
          problems.push(
            `Prepared file '${p.value}' does not exist in storage.`,
          );
        }
      }
    }

    return problems;
  }

  /** Whether a prepared inline text satisfies an expected inline-text entry. */
  private inlineMatches(expectedValue: string, preparedValue: string): boolean {
    if (expectedValue === '') return true;
    try {
      return new RegExp(expectedValue).test(preparedValue);
    } catch {
      // A malformed expected regex can never be satisfied — treat as unmatched.
      return false;
    }
  }

  /** Builds the corrective message returned to the agent on a gate failure. */
  private buildGateMessage(problems: string[]): string {
    return [
      'Your submission does not yet meet the assignment’s expected outputs:',
      ...problems.map((p) => `- ${p}`),
      '',
      'Write the missing outputs (or correct the paths/text) and call complete_assignment again.',
    ].join('\n');
  }

  /** Recomputes and persists a task's status from its implement-mode plan. */
  private async recomputeTaskStatus(taskId: UUID): Promise<void> {
    const task = await this.taskRepo.findOneBy({ id: taskId });
    if (!task) return;
    const planAssignments = await this.assignmentRepo.find({
      where: { taskId, mode: 'implement' },
    });
    const next = deriveTaskStatus(task.status, planAssignments);
    if (next !== task.status) {
      await this.taskRepo.update(taskId, { status: next });
    }
  }

  /** Atomic status claim; returns the number of rows affected (0 = lost the race). */
  private async claimStatus(
    id: UUID,
    from: LcpAssignmentStatus,
    to: LcpAssignmentStatus,
  ): Promise<number> {
    const result = await this.assignmentRepo
      .createQueryBuilder()
      .update(LcpAssignment)
      .set({ status: to })
      .where('id = :id', { id })
      .andWhere('status = :from', { from })
      .execute();
    return result.affected ?? 0;
  }

  private async loadAssignment(id: UUID): Promise<LcpAssignment> {
    const assignment = await this.assignmentRepo.findOneBy({ id });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${id} not found`);
    }
    return assignment;
  }

  /** Rejects any artifact whose `type` falls outside the allowed union. */
  private assertArtifactTypes(
    index: number,
    field: string,
    artifacts: LcpArtifact[],
    allowed: Set<string>,
  ): void {
    for (const a of artifacts) {
      if (!allowed.has(a.type)) {
        throw new BadRequestException(
          `Assignment ${index}: ${field} artifact type '${a.type}' is not allowed here.`,
        );
      }
    }
  }
}
