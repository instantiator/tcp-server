import {
  AgentStatus,
  AuditEvent,
  AuditEventType,
  buildAgentChangeSummary,
  buildEnumValidationError,
  canonicaliseArtifacts,
  deriveTaskStatus,
  TcpAgent,
  TcpAssignment,
  TcpAssignmentStatus,
  TcpAssignmentWorkingArtifact,
  TcpRole,
  TcpTask,
  stripControlChars,
} from '@tcp/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  invalidArtifactTypeErrors,
  WORKING_ARTIFACT_TYPES,
} from './artifact-types';
import { claimStatus } from './claim-status';
import { buildGateMessage, OutputGateService } from './output-gate.service';
import { PauseAndResumeService } from './pause-and-resume.service';
import { TaskDispatcher } from './task-dispatcher.service';

/**
 * The `complete_assignment` transition: an agent hands over what it produced,
 * and the assignment moves out of `in-progress` — to QA, to succeeded, or to
 * the task's finalisation, depending on what kind of assignment it was.
 *
 * The atomic claim in {@link claimAndPersist} is what makes a duplicate or
 * concurrent completion safe: only one caller can move the row off
 * `in-progress`, and only that caller writes the result.
 */
@Injectable()
export class AssignmentCompletionService {
  private readonly logger = new Logger(AssignmentCompletionService.name);

  constructor(
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    @InjectRepository(TcpTask)
    private readonly taskRepo: Repository<TcpTask>,
    @InjectRepository(TcpRole)
    private readonly roleRepo: Repository<TcpRole>,
    private readonly dispatcher: TaskDispatcher,
    private readonly pauseResume: PauseAndResumeService,
    private readonly gate: OutputGateService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Validates the caller and that the prepared artifacts satisfy what was asked
   * for (the mechanical gate), then takes whichever of the three endings
   * applies.
   *
   * @throws {@link UnprocessableEntityException} (422) on a gate failure, with a
   *   corrective message the MCP layer relays to the agent.
   * @throws {@link ConflictException} (409) when the assignment is no longer
   *   `in-progress` (a concurrent/duplicate completion won).
   */
  async complete(
    assignment: TcpAssignment,
    agentId: UUID,
    summary: string,
    prepared: TcpAssignmentWorkingArtifact[],
  ): Promise<void> {
    this.assertCompletableBy(assignment, agentId);

    // Strip stray control chars from model text so stored JSON stays valid.
    const cleanSummary = stripControlChars(summary);
    const canonPrepared = this.canonicalisePrepared(prepared);

    if (assignment.mode === 'finalise') {
      await this.finaliseTask(assignment, canonPrepared, cleanSummary);
      return;
    }

    const gate = await this.gate.checkAssignmentOutputs(
      assignment,
      canonPrepared,
    );
    if (gate.length > 0) {
      throw new UnprocessableEntityException(buildGateMessage(gate));
    }

    if (assignment.taskId === null || assignment.taskId === undefined) {
      await this.completeOrphan(
        assignment,
        agentId,
        canonPrepared,
        cleanSummary,
      );
      return;
    }
    await this.handToQa(assignment, agentId, canonPrepared, cleanSummary);
  }

  /**
   * Ends a chat because the person having it says it is over.
   *
   * Deliberately not a mode added to {@link complete}: almost nothing about
   * that path applies here. The caller is a **user**, authenticated by JWT and
   * company membership at the controller, not the agent holding the assignment
   * — so {@link assertCompletableBy}'s `assignment.agentId !== agentId`
   * Forbidden check is the wrong question to ask. A chat prepares no artifacts,
   * writes no summary and has no output gate to satisfy. And the mode
   * restriction is the exact inverse of that method's: chat only, where it
   * rejects chat.
   *
   * @throws {@link BadRequestException} when the assignment is not a chat.
   * @throws {@link ConflictException} when the agent is mid-turn, has no agent
   *   to complete, or the assignment has already been completed.
   */
  async completeChat(assignment: TcpAssignment): Promise<void> {
    if (assignment.mode !== 'chat') {
      throw new BadRequestException(
        `Assignment ${assignment.id} is not a chat (mode: ${assignment.mode}).`,
      );
    }
    const agentId = assignment.agentId;
    if (!agentId) {
      throw new ConflictException(
        `Chat ${assignment.id} has no agent to complete.`,
      );
    }

    // Read the agent's status now rather than trusting the copy loaded with
    // the assignment: a turn that started a moment ago must not be completed
    // out from under. There is necessarily a window between this read and the
    // claim below — that is acceptable, because this is a courtesy to the user
    // rather than a security boundary. The claim is what makes the transition
    // itself safe.
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (agent?.status === AgentStatus.Running) {
      throw new ConflictException(
        `Agent ${agentId} is mid-turn; wait for the reply before completing the chat.`,
      );
    }

    await this.claimAndPersist(
      assignment,
      'succeeded',
      [],
      '',
      `Assignment ${assignment.id} was already completed.`,
    );

    // The agent's own last reply is handed back rather than an empty string:
    // `completeAgent` writes whatever output it is given, and the agent's
    // `output` is what `GET /api/agent/:id/events` replays to a client that
    // reconnects to a finished chat.
    await this.pauseResume.completeAgent(agentId, agent?.output ?? '');
    this.logger.log(`Chat assignment ${assignment.id} completed by a user`);
  }

  /**
   * Deletes a chat outright: its audit rows (the transcript) and its
   * assignment, which cascades to the agent. One transaction, so a failure
   * cannot leave a transcript-less chat behind. Unlike
   * {@link completeChat} nothing is kept, so the person must mean it.
   *
   * @throws {@link BadRequestException} when the assignment is not a chat.
   * @throws {@link ConflictException} when the agent is mid-turn.
   */
  async deleteChat(assignment: TcpAssignment): Promise<void> {
    if (assignment.mode !== 'chat') {
      throw new BadRequestException(
        `Assignment ${assignment.id} is not a chat (mode: ${assignment.mode}).`,
      );
    }
    const agentId = assignment.agentId;
    if (agentId) {
      const agent = await this.agentRepo.findOneBy({ id: agentId });
      if (agent?.status === AgentStatus.Running) {
        throw new ConflictException(
          `Agent ${agentId} is mid-turn; wait for the reply before deleting the chat.`,
        );
      }
    }

    await this.assignmentRepo.manager.transaction(async (em) => {
      // Audit rows carry no foreign key, so they would outlive the chat.
      const { companyId } = assignment;
      if (agentId) await em.delete(AuditEvent, { companyId, agentId });
      await em.delete(AuditEvent, { companyId, assignmentId: assignment.id });
      await em.delete(TcpAssignment, { id: assignment.id });
    });
    this.logger.log(`Chat assignment ${assignment.id} deleted by a user`);
  }

  /**
   * The finalise ending: the task's own expected outputs are checked against
   * the completed/ directory, then the task is handed to the dispatcher to be
   * marked succeeded.
   */
  private async finaliseTask(
    assignment: TcpAssignment,
    prepared: TcpAssignmentWorkingArtifact[],
    summary: string,
  ): Promise<void> {
    // Finalise is a task-level check against the task's expected outputs over
    // the task completed/ directory (the finalise agent's working area) — not
    // the per-assignment output gate.
    const problems = await this.gate.checkTaskExpectations(
      assignment,
      prepared,
    );
    if (problems.length > 0) {
      throw new UnprocessableEntityException(buildGateMessage(problems));
    }
    await this.claimAndPersist(
      assignment,
      'succeeded',
      prepared,
      summary,
      `Assignment ${assignment.id} was already finalised.`,
    );
    await this.dispatcher.assignmentFinalised(assignment);
  }

  /**
   * The orphan (task-less) ending: the prepared work is immediately final —
   * there is no QA cycle — and the agent completes through the same path as
   * `/internal/agent/:id/complete`, so consultations and conversations resolve
   * exactly as they would otherwise.
   */
  private async completeOrphan(
    assignment: TcpAssignment,
    agentId: UUID,
    prepared: TcpAssignmentWorkingArtifact[],
    summary: string,
  ): Promise<void> {
    await this.claimAndPersist(
      assignment,
      'succeeded',
      prepared,
      summary,
      `Assignment ${assignment.id} was already completed.`,
    );
    await this.pauseResume.completeAgent(agentId, summary);
    this.logger.log(`Orphan assignment ${assignment.id} completed`);
  }

  /**
   * The task-assignment ending: record the submission, pause the agent so the
   * dispatcher can resume it with the QA verdict, and ask for a QA agent.
   */
  private async handToQa(
    assignment: TcpAssignment,
    agentId: UUID,
    prepared: TcpAssignmentWorkingArtifact[],
    summary: string,
  ): Promise<void> {
    await this.claimAndPersist(
      assignment,
      'in-qa',
      prepared,
      summary,
      `Assignment ${assignment.id} was already handed to QA.`,
    );

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
    });
    // Persist-then-publish (002.02 stage 2): the QA hand-off pause wrote no
    // event before, so a client watching this agent only learned it had
    // paused once the QA agent's own activity implied it.
    await this.publishAgentPaused(agentId, 'handed to QA');

    await this.dispatcher.assignmentReadyForQa(assignment);
    await this.recomputeTaskStatus(assignment.taskId!);
    this.logger.log(`Assignment ${assignment.id} handed to QA`);
  }

  /**
   * Rejects a completion the caller is not entitled to make: a different
   * agent's assignment, a mode that has no `complete_assignment` step, or one
   * that is no longer running.
   */
  private assertCompletableBy(assignment: TcpAssignment, agentId: UUID): void {
    if (assignment.agentId !== agentId) {
      throw new ForbiddenException(
        `Agent ${agentId} is not the agent assigned to ${assignment.id}.`,
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
        `Assignment ${assignment.id} is not in-progress (status: ${assignment.status}).`,
      );
    }
  }

  /**
   * Normalises alias/near-miss types (e.g. `text` → `inline-text`) before
   * validating and storing, so a good answer isn't rejected on a spelling;
   * inline-text values are sanitised the same way as the summary.
   *
   * @throws {@link BadRequestException} listing every unusable artifact type.
   */
  private canonicalisePrepared(
    prepared: TcpAssignmentWorkingArtifact[],
  ): TcpAssignmentWorkingArtifact[] {
    const canonical = canonicaliseArtifacts(prepared).map((p) =>
      p.type === 'inline-text'
        ? { ...p, value: stripControlChars(p.value) }
        : p,
    );
    const invalid = invalidArtifactTypeErrors(
      canonical,
      WORKING_ARTIFACT_TYPES,
      'prepared type',
    );
    if (invalid.length > 0) {
      throw new BadRequestException(
        buildEnumValidationError('complete the assignment', invalid),
      );
    }
    return canonical;
  }

  /**
   * Atomically moves the assignment out of `in-progress` into `to`, then
   * persists the agent's prepared outputs and summary against it.
   *
   * The claim is what stops two concurrent completions both proceeding: a
   * zero row count means another writer already moved the assignment on, so
   * this caller lost the race and must not write over the winner's result.
   *
   * @param conflictMessage - What the loser of that race is told.
   * @throws {ConflictException} when the assignment was already claimed.
   */
  private async claimAndPersist(
    assignment: TcpAssignment,
    to: TcpAssignmentStatus,
    prepared: TcpAssignmentWorkingArtifact[],
    summary: string,
    conflictMessage: string,
  ): Promise<void> {
    const claim = await claimStatus(
      this.assignmentRepo,
      assignment.id,
      'in-progress',
      to,
    );
    if (claim === 0) {
      throw new ConflictException(conflictMessage);
    }
    assignment.prepared = prepared;
    assignment.summary = summary;
    assignment.status = to;
    await this.assignmentRepo.save(assignment);
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

  /**
   * Publishes an agent `state_change` to `paused`, with a summary, for a
   * write already made. Called after the write, never before — a client that
   * refetches on the event must find the row already updated.
   */
  private async publishAgentPaused(
    agentId: UUID,
    reason: string,
  ): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) return;
    const role = await this.roleRepo.findOneBy({ id: agent.roleId });
    await this.audit.record(
      agent.companyId,
      role?.name ?? 'agent',
      agentId,
      AuditEventType.StateChange,
      {
        entity: 'agent',
        newStatus: AgentStatus.Paused,
        reason,
        summary: buildAgentChangeSummary({
          ...agent,
          status: AgentStatus.Paused,
        }),
      },
    );
  }
}
