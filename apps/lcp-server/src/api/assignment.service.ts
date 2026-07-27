import {
  AgentStatus,
  artifactTypeDisplayName,
  assignmentWorkingPrefix,
  buildAssignmentShortcode,
  buildEnumValidationError,
  canonicaliseArtifacts,
  deriveTaskStatus,
  isStorageReadOnly,
  InvalidEnumValue,
  TcpAgent,
  TcpArtifact,
  TcpAssignment,
  TcpAssignmentMode,
  TcpAssignmentWorkingArtifact,
  TcpMaterialArtifact,
  TcpTask,
  orphanWorkingPrefix,
  resolveArtifactKey,
  stripControlChars,
  taskCompletedPrefix,
} from '@tcp/shared';
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
import { claimStatus } from './claim-status';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';
import type { PlanAssignmentInput } from './dto/internal-task.dto';

/** A single material resolved to a concrete storage key (or literal inline text). */
export interface ResolvedMaterial {
  /** Stable name the model addresses the material by (`inline-N` for inline text). */
  name: string;
  /** Full storage key, or `null` for an inline-text material. */
  key: string | null;
  /** Literal content, present only for inline-text materials. */
  inlineText?: string;
}

/**
 * The storage scope for an agent, resolved server-side from its assignment —
 * backs the assignment-scoped storage tools in lcp-mcp-storage (part 6). For a
 * qa-mode caller the scope is the *target* assignment's (read-only).
 */
export interface StorageScope {
  mode: TcpAssignmentMode;
  /** True for qa-mode callers — the working tools may only read. */
  readOnly: boolean;
  /** Object-key prefix (ending in `/`) of the scoped working directory. */
  workingPrefix: string;
  /** The scoped assignment's materials, resolved to concrete keys/inline text. */
  materials: ResolvedMaterial[];
}

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
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
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
   * Resolves the {@link StorageScope} for an agent — the working-directory
   * prefix and materials the assignment-scoped storage tools operate on.
   *
   * The read/write vs read-only distinction comes from {@link MODE_TOOLS} (via
   * {@link isStorageReadOnly}), the single source of truth shared with the
   * client-side tool filter. The working area depends on the mode:
   * `implement`/`consultee` get their own assignment's working directory; a `qa`
   * caller gets the *target* assignment's working directory (read-only); a
   * `finalise` caller gets the *task* `completed/` directory (read-write, to
   * bring the deliverables up to the task's expected outputs); `plan` gets its
   * own (read-only). Materials are the scoped assignment's `materials`, resolved
   * to concrete storage keys ({@link resolveArtifactKey}), with inline-text
   * materials keyed by a stable `inline-N` synthetic name.
   */
  async resolveStorageScope(agentId: UUID): Promise<StorageScope> {
    const { assignment: caller } = await this.getAgentAssignment(agentId);
    const readOnly = isStorageReadOnly(caller.mode);
    // Only qa works against another assignment's output; every other mode works
    // in its own area.
    const target =
      caller.mode === 'qa' ? await this.loadTargetAssignment(caller) : caller;

    const company = await this.db.getCompany(caller.companyId);
    if (!company) {
      throw new NotFoundException(`Company ${caller.companyId} not found`);
    }
    const slug = company.slug;

    const workingPrefix =
      caller.mode === 'finalise' && caller.taskId != null
        ? taskCompletedPrefix(slug, caller.taskId)
        : target.taskId != null && target.orderIndex != null
          ? assignmentWorkingPrefix(slug, target.taskId, target.orderIndex)
          : orphanWorkingPrefix(slug, target.id);

    const materials = await this.resolveMaterials(slug, target);
    return { mode: caller.mode, readOnly, workingPrefix, materials };
  }

  /** Loads the assignment a qa-mode caller is reviewing. */
  private async loadTargetAssignment(
    caller: TcpAssignment,
  ): Promise<TcpAssignment> {
    if (!caller.targetAssignmentId) {
      throw new BadRequestException(
        `Your qa assignment has no target assignment to review.`,
      );
    }
    return this.loadAssignment(caller.targetAssignmentId);
  }

  /**
   * Resolves an assignment's `materials` list to {@link ResolvedMaterial}s.
   * A material that cannot be resolved (e.g. an `assignment-completed-path`
   * no prior assignment has approved) fails the whole scope lookup — a
   * silently incomplete materials list would leave the agent working from
   * missing input with no indication why; `planTask`'s cross-reference check
   * should keep this unreachable for a plan created normally, so this is a
   * backstop, not the expected path.
   */
  private async resolveMaterials(
    slug: string,
    target: TcpAssignment,
  ): Promise<ResolvedMaterial[]> {
    const planAssignments = target.taskId
      ? (
          await this.assignmentRepo.find({
            where: { taskId: target.taskId, mode: 'implement' },
          })
        ).map((a) => ({ orderIndex: a.orderIndex, approved: a.approved }))
      : undefined;
    const ctx = {
      companySlug: slug,
      task: target.taskId ? { id: target.taskId } : null,
      planAssignments,
      assignment: {
        id: target.id,
        taskId: target.taskId ?? null,
        orderIndex: target.orderIndex ?? null,
      },
    };

    const materials: ResolvedMaterial[] = [];
    let inlineCount = 0;
    for (const m of target.materials) {
      if (m.type === 'inline-text') {
        inlineCount += 1;
        materials.push({
          name: `inline-${inlineCount}`,
          key: null,
          inlineText: m.value,
        });
        continue;
      }
      let key: string | null;
      try {
        key = resolveArtifactKey(m, ctx);
      } catch (e) {
        throw new UnprocessableEntityException(
          `Cannot resolve material '${m.value}' (${m.type}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // ponytail: name = the artifact's filename; two path materials with
      // the same basename would collide — acceptable until it bites.
      if (key) materials.push({ name: m.value, key });
    }
    return materials;
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
    const task = await this.taskRepo.findOneByOrFail({ id: taskId });

    if (!Array.isArray(assignments) || assignments.length === 0) {
      throw new BadRequestException(
        'A plan must contain at least one assignment.',
      );
    }

    // Structural (non-enumerable) checks fail fast — there is no set of "valid
    // values" to offer for a missing prompt.
    for (const [i, a] of assignments.entries()) {
      if (!a.prompt || !a.prompt.trim()) {
        throw new BadRequestException(`Assignment ${i}: prompt is required.`);
      }
    }

    // Resolve every role and validate every artifact type up front, collecting
    // ALL invalid enumerable values so the planner can correct them in a single
    // retry (nothing is created on any failure). Each invalid value's error
    // names the valid options — the roles/types the planner must choose from.
    const validRoleSlugs = (await this.db.listRoles(caller.companyId)).map(
      (r) => r.slug,
    );
    const invalid: InvalidEnumValue[] = [];
    const roleIds: UUID[] = [];
    // Canonical (alias-normalised) artifact lists, kept per assignment so the
    // stored rows use canonical types (e.g. `text` → `inline-text`).
    const expectedByIndex: TcpAssignmentWorkingArtifact[][] = [];
    const materialsByIndex: TcpMaterialArtifact[][] = [];
    for (const [i, a] of assignments.entries()) {
      const role = a.role?.trim()
        ? await this.db.findRoleByIdOrSlug(caller.companyId, a.role)
        : null;
      if (!role) {
        invalid.push({
          property: `assignment ${i} role`,
          value: a.role ?? '',
          validValues: validRoleSlugs,
        });
      }
      // Placeholder keeps roleIds aligned with assignments; only read after the
      // invalid check below passes (so an unresolved role is never used).
      roleIds.push(role?.id ?? ('' as UUID));

      const expected = canonicaliseArtifacts(a.expected ?? []);
      const materials = canonicaliseArtifacts(a.materials ?? []);
      expectedByIndex.push(expected);
      materialsByIndex.push(materials);
      for (const type of this.invalidArtifactTypes(
        expected,
        WORKING_ARTIFACT_TYPES,
      )) {
        invalid.push({
          property: `assignment ${i} expected type`,
          value: type,
          validValues: this.artifactTypeValidValues(WORKING_ARTIFACT_TYPES),
        });
      }
      for (const type of this.invalidArtifactTypes(
        materials,
        MATERIAL_ARTIFACT_TYPES,
      )) {
        invalid.push({
          property: `assignment ${i} materials type`,
          value: type,
          validValues: this.artifactTypeValidValues(MATERIAL_ARTIFACT_TYPES),
        });
      }
    }

    // Cross-reference check: an `assignment-completed-path` material names a
    // prior step's approved output — which only ever exists if an EARLIER
    // assignment in this same plan commits to producing that exact filename
    // (its `expected` list, type `assignment-working-path`; `checkOutputGate`
    // then mechanically enforces the implementer actually produces it). This
    // is purely structural — no execution has to happen to check it — so a
    // typo or a reference to a step that never promises that file is caught
    // here, before anything is created, rather than crashing prompt assembly
    // partway through the plan's execution (see `resolveArtifactKey`).
    for (const [i, materials] of materialsByIndex.entries()) {
      const producedByEarlier = expectedByIndex
        .slice(0, i)
        .flatMap((expected) =>
          expected
            .filter((e) => e.type === 'assignment-working-path')
            .map((e) => e.value),
        );
      materials.forEach((m, mi) => {
        if (m.type !== 'assignment-completed-path') return;
        if (!producedByEarlier.includes(m.value)) {
          invalid.push({
            property: `assignment ${i} materials[${mi}] value`,
            value: m.value,
            validValues: producedByEarlier,
          });
        }
      });
    }

    if (invalid.length > 0) {
      throw new BadRequestException(
        buildEnumValidationError('create the plan', invalid),
      );
    }

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
          roleId: roleIds[i],
          status: 'ready',
          materials: materialsByIndex[i],
          expected: expectedByIndex[i],
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
    prepared: TcpAssignmentWorkingArtifact[],
  ): Promise<void> {
    const assignment = await this.loadAssignment(assignmentId);
    if (assignment.agentId !== agentId) {
      throw new ForbiddenException(
        `Agent ${agentId} is not the agent assigned to ${assignmentId}.`,
      );
    }
    if (
      assignment.mode !== 'implement' &&
      assignment.mode !== 'consultee' &&
      assignment.mode !== 'finalise'
    ) {
      throw new BadRequestException(
        `complete_assignment is only valid for implement, consultee, or finalise assignments.`,
      );
    }
    if (assignment.status !== 'in-progress') {
      throw new ConflictException(
        `Assignment ${assignmentId} is not in-progress (status: ${assignment.status}).`,
      );
    }

    // Strip stray control chars from model text so stored JSON stays valid.
    const cleanSummary = stripControlChars(summary);
    // Normalise alias/near-miss types (e.g. `text` → `inline-text`) before
    // validating and storing, so a good answer isn't rejected on a spelling;
    // sanitise inline-text values the same way.
    const canonPrepared = canonicaliseArtifacts(prepared).map((p) =>
      p.type === 'inline-text'
        ? { ...p, value: stripControlChars(p.value) }
        : p,
    );
    const invalidPrepared = this.invalidArtifactTypes(
      canonPrepared,
      WORKING_ARTIFACT_TYPES,
    ).map((type) => ({
      property: 'prepared type',
      value: type,
      validValues: this.artifactTypeValidValues(WORKING_ARTIFACT_TYPES),
    }));
    if (invalidPrepared.length > 0) {
      throw new BadRequestException(
        buildEnumValidationError('complete the assignment', invalidPrepared),
      );
    }

    // Finalise is a task-level check against the task's expected outputs over
    // the task completed/ directory (the finalise agent's working area) — not
    // the per-assignment output gate.
    if (assignment.mode === 'finalise') {
      const problems = await this.checkTaskExpectations(
        assignment,
        canonPrepared,
      );
      if (problems.length > 0) {
        throw new UnprocessableEntityException(this.buildGateMessage(problems));
      }
      const claim = await claimStatus(
        this.assignmentRepo,
        assignmentId,
        'in-progress',
        'succeeded',
      );
      if (claim === 0) {
        throw new ConflictException(
          `Assignment ${assignmentId} was already finalised.`,
        );
      }
      assignment.prepared = canonPrepared;
      assignment.summary = cleanSummary;
      assignment.status = 'succeeded';
      await this.assignmentRepo.save(assignment);
      await this.dispatcher.assignmentFinalised(assignment);
      return;
    }

    const gate = await this.checkOutputGate(assignment, canonPrepared);
    if (gate.length > 0) {
      throw new UnprocessableEntityException(this.buildGateMessage(gate));
    }

    if (assignment.taskId === null || assignment.taskId === undefined) {
      // Orphan: the prepared work is immediately final (there is no QA cycle).
      const claim = await claimStatus(
        this.assignmentRepo,
        assignmentId,
        'in-progress',
        'succeeded',
      );
      if (claim === 0) {
        throw new ConflictException(
          `Assignment ${assignmentId} was already completed.`,
        );
      }
      assignment.prepared = canonPrepared;
      assignment.summary = cleanSummary;
      assignment.status = 'succeeded';
      await this.assignmentRepo.save(assignment);
      // Same completion path as complete_task used to take — resolves any
      // pending consultation/conversation for this agent.
      await this.pauseResume.completeAgent(agentId, cleanSummary);
      this.logger.log(`Orphan assignment ${assignmentId} completed`);
      return;
    }

    // Task assignment: hand off to QA. Record prepared/summary, pause the
    // agent so part 7 can resume it with the QA verdict.
    const claim = await claimStatus(
      this.assignmentRepo,
      assignmentId,
      'in-progress',
      'in-qa',
    );
    if (claim === 0) {
      throw new ConflictException(
        `Assignment ${assignmentId} was already handed to QA.`,
      );
    }
    assignment.prepared = canonPrepared;
    assignment.summary = cleanSummary;
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

  /**
   * The mechanical output gate: returns the list of unmet requirements (empty
   * when the prepared artifacts satisfy the assignment's expected outputs).
   * It checks the *shape* of the output, not its content quality — judging
   * whether the content is actually right is the QA agent's job, so the gate
   * never blocks a reasonable submission before QA can see it.
   *
   * - each expected `assignment-working-path` must appear in `prepared` and its
   *   resolved storage key must exist;
   * - each expected `inline-text` requires a non-empty `inline-text` artifact in
   *   `prepared` (its content is judged by QA, not matched here — the expected
   *   `value` is a description for the agent/QA, not an enforced pattern);
   * - each prepared `assignment-working-path` must exist in storage.
   */
  private async checkOutputGate(
    assignment: TcpAssignment,
    prepared: TcpAssignmentWorkingArtifact[],
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

    // Expected coverage — shape only (QA judges content).
    const hasInline = preparedInline.some((p) => p.value.trim() !== '');
    for (const exp of assignment.expected) {
      if (exp.type === 'assignment-working-path') {
        if (!preparedPaths.some((p) => p.value === exp.value)) {
          problems.push(
            `Expected file '${exp.value}': create it in your working directory, then include it in your prepared list as { "type": "assignment-working-path", "value": "${exp.value}" }.`,
          );
        }
      } else if (exp.type === 'inline-text' && !hasInline) {
        problems.push(
          exp.value
            ? `Expected a text answer (${exp.value}): include it in your prepared list as { "type": "inline-text", "value": "<your text>" } — a file is not accepted for this output.`
            : `Expected a text answer: include it in your prepared list as { "type": "inline-text", "value": "<your text>" } — a file is not accepted for this output.`,
        );
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

  /** Builds the corrective message returned to the agent on a gate failure. */
  private buildGateMessage(problems: string[]): string {
    return [
      'Your submission does not yet meet the assignment’s expected outputs:',
      ...problems.map((p) => `- ${p}`),
      '',
      'Fix each item above, then call complete_assignment again with the corrected `prepared` list. `prepared` holds the artifacts you are handing over — a `{ type: "assignment-working-path", value }` entry per file, and/or a `{ type: "inline-text", value }` entry per text answer.',
    ].join('\n');
  }

  /**
   * The finalise gate: checks the task's `expected` outputs against the files
   * actually in the task `completed/` directory (the finalise agent's working
   * area). Shape only — each expected `task-completed-path` file must be
   * present, each expected `inline-text` must have a non-empty inline-text
   * artifact in `prepared`. Returns the list of unmet requirements.
   */
  private async checkTaskExpectations(
    finalise: TcpAssignment,
    prepared: TcpAssignmentWorkingArtifact[],
  ): Promise<string[]> {
    const problems: string[] = [];
    const company = await this.db.getCompany(finalise.companyId);
    if (!company) return [`Company ${finalise.companyId} not found.`];
    const task = await this.taskRepo.findOneBy({ id: finalise.taskId! });
    if (!task) return [`Task ${finalise.taskId} not found.`];

    const present = new Set(
      (
        await this.storage.listFiles(taskCompletedPrefix(company.slug, task.id))
      ).map((f) => f.name),
    );
    const hasInline = prepared.some(
      (p) => p.type === 'inline-text' && p.value.trim() !== '',
    );
    for (const exp of task.expected) {
      if (exp.type === 'task-completed-path' && !present.has(exp.value)) {
        problems.push(
          `Expected deliverable '${exp.value}' is not among the task's completed files (present: ${[...present].join(', ') || 'none'}). Rename or create a file so '${exp.value}' appears in the completed set.`,
        );
      } else if (exp.type === 'inline-text' && !hasInline) {
        problems.push(
          exp.value
            ? `Expected a text answer (${exp.value}): include it as an inline-text artifact in your prepared list.`
            : `Expected a text answer: include it as an inline-text artifact in your prepared list.`,
        );
      }
    }
    return problems;
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

  private async loadAssignment(id: UUID): Promise<TcpAssignment> {
    const assignment = await this.assignmentRepo.findOneBy({ id });
    if (!assignment) {
      throw new NotFoundException(`Assignment ${id} not found`);
    }
    return assignment;
  }

  /** Rejects any artifact whose `type` falls outside the allowed union. */
  /** Returns the distinct artifact `type` values in `artifacts` not in `allowed`. */
  private invalidArtifactTypes(
    artifacts: TcpArtifact[],
    allowed: Set<string>,
  ): string[] {
    return [
      ...new Set(
        artifacts.map((a) => a.type).filter((type) => !allowed.has(type)),
      ),
    ];
  }

  /**
   * Renders an allowed artifact-type set in the short, LLM-facing vocabulary
   * (`file`/`text`/...) so a corrective error matches what the tool
   * description advertised, not the longer internal storage-path name.
   */
  private artifactTypeValidValues(allowed: Set<string>): string[] {
    return [...allowed].map(artifactTypeDisplayName);
  }
}
