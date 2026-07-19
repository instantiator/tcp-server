import {
  AgentStatus,
  AuditEventType,
  LcpAgent,
  LcpRole,
  PendingConsultation,
} from '@lcp/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ConversationService } from './conversation.service';

/**
 * Coordinates the pause/resume lifecycle for agents interrupted by a
 * `request_user_input` or `request_agent_consultation` MCP tool call.
 *
 * - **Pause for user input**: creates a {@link Conversation}, sets the agent
 *   status to {@link AgentStatus.Paused}, and returns the conversation slug so
 *   the MCP tool can report it back to the agent.
 * - **Pause for consultation**: sets the calling agent to Paused, starts a new
 *   consultation agent, and creates a {@link PendingConsultation} record.
 * - **Complete agent**: marks the agent as {@link AgentStatus.Completed} with
 *   its output; if the agent was a consultation agent it also resolves the
 *   {@link PendingConsultation} and re-enqueues the calling agent.
 */
@Injectable()
export class PauseAndResumeService {
  private readonly logger = new Logger(PauseAndResumeService.name);

  constructor(
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
    @InjectRepository(LcpRole)
    private readonly roleRepo: Repository<LcpRole>,
    @InjectRepository(PendingConsultation)
    private readonly consultRepo: Repository<PendingConsultation>,
    private readonly convService: ConversationService,
    private readonly orchestration: AgentOrchestrationService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Records an agent `state_change` capturing a lifecycle transition — the
   * single source for both history and the live `GET /api/agent/:id/events`
   * stream (the publisher routes it). Callers pass the denormalised company
   * and role they already hold.
   */
  private async recordStatus(
    agentId: UUID,
    companyId: UUID,
    roleName: string,
    status: AgentStatus,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      companyId,
      roleName,
      agentId,
      AuditEventType.StateChange,
      { entity: 'agent', newStatus: status, ...extra },
    );
  }

  /**
   * Pauses the agent and creates a human-readable {@link Conversation} query.
   * Returns the conversation slug the MCP tool should report to the agent.
   */
  async pauseForUserInput(
    agentId: UUID,
    question: string,
    context?: string,
    userIds?: UUID[],
  ): Promise<{ slug: string }> {
    // Look up the agent and its role — the role name is used purely for the
    // conversation slug, not as a lookup key.
    const agent = await this.loadAgent(agentId);
    const role = await this.roleRepo.findOneBy({ id: agent.roleId });

    // Mark the agent paused, recording when so a later resume can scope which
    // responses belong to this pause episode.
    await this.agentRepo.update(agentId, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
    });

    // Create the conversation — routes to explicit userIds when given,
    // otherwise falls back to ConversationService's keyword-matching heuristic.
    const conv = await this.convService.create(
      agent.companyId,
      agent.roleId,
      role?.name ?? 'agent',
      agentId,
      question,
      context,
      userIds,
    );

    await this.recordStatus(
      agentId,
      agent.companyId,
      role?.name ?? 'agent',
      AgentStatus.Paused,
      { reason: 'user_input', conversationSlug: conv.slug },
    );
    this.logger.log(
      `Agent ${agentId} paused for user input — conversation ${conv.slug}`,
    );
    return { slug: conv.slug };
  }

  /**
   * Pauses the calling agent, starts a consultation agent for the role
   * identified by `roleId`, and records the {@link PendingConsultation} link
   * between them. Returns the consultation id and the resolved role name.
   */
  async pauseForConsultation(
    callingAgentId: UUID,
    companyId: UUID,
    roleId: UUID,
    question: string,
    context?: string,
    roleName?: string,
  ): Promise<{ consultationId: UUID; roleName: string }> {
    const callingAgent = await this.loadAgent(callingAgentId);

    // Look up the target role by id, scoped to the company — role names
    // aren't unique within a company, so id is the only unambiguous key.
    const role = await this.roleRepo.findOne({
      where: { id: roleId, companyId },
    });
    if (!role) {
      throw new NotFoundException(
        `No role with id '${roleId}'${roleName ? ` ('${roleName}')` : ''} found in company ${companyId}`,
      );
    }

    // Mark the calling agent paused, recording when so a later resume can
    // scope which responses belong to this pause episode.
    await this.agentRepo.update(callingAgentId, {
      status: AgentStatus.Paused,
      pausedAt: new Date(),
    });

    const callingRole = await this.roleRepo.findOneBy({
      id: callingAgent.roleId,
    });
    // The consultee-mode prompt (MODE_PROMPTS.consultee) frames the task — how to
    // answer and to complete via complete_assignment — so the initial prompt
    // just carries the question and context.
    const initialPrompt = [
      context ? `Context: ${context}` : null,
      `Question: ${question}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Create the agent record first, then commit the consultation link, then
    // dispatch the job. This ordering prevents a race where the worker picks
    // up the job and calls completeAgent before the PendingConsultation row
    // exists — completeAgent would find no pending consultation and return
    // without resuming the calling agent.
    const consultAgent = await this.orchestration.createAgent({
      companyId,
      roleId: role.id,
      initialPrompt,
      // Consultation results are only delivered via complete_assignment — a
      // narrated answer would never resolve the PendingConsultation, so enforce
      // the call. The consulting agent's orphan assignment is consultee-mode.
      mode: 'consultee',
      requiredToolCalls: ['complete_assignment'],
      // Links the new consultation assignment back to the task it was spawned
      // for (via the calling agent's own assignment) — see LcpAssignment.parentAssignmentId.
      parentAssignmentId: callingAgent.assignmentId,
    });

    // Record the link between the paused caller and the new consulting agent.
    const consultation = await this.consultRepo.save(
      this.consultRepo.create({
        callingAgentId,
        consultationAgentId: consultAgent.id,
        companyId,
        status: 'pending',
        result: null,
      }),
    );

    // Only now dispatch the job — the PendingConsultation row is committed.
    await this.orchestration.dispatchStartJob(consultAgent.id);

    // Tell any client watching the calling agent that it paused to consult, and
    // which agent to follow — CLI follower spawning keys on `consultedAgentId`.
    await this.recordStatus(
      callingAgentId,
      callingAgent.companyId,
      callingRole?.name ?? 'agent',
      AgentStatus.Paused,
      {
        reason: 'consultation',
        consultedAgentId: consultAgent.id,
        consultedRoleName: role.name,
      },
    );

    this.logger.log(
      `Agent ${callingAgentId} (${callingRole?.name ?? '?'}) paused for consultation — consulting agent ${consultAgent.id} (${role.name}), consultation ${consultation.id}`,
    );
    return { consultationId: consultation.id, roleName: role.name };
  }

  /**
   * Marks an agent as {@link AgentStatus.Completed} with the given output.
   * If the agent was performing a consultation, resolves the pending record
   * and re-enqueues the calling agent with the result as `replyContent`.
   *
   * Idempotent: a no-op if the agent is already Completed.
   */
  async completeAgent(agentId: UUID, output: string): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) return;

    // Update status and output only when not already completed — idempotent
    // for the agent record itself. AgentLoopService may have already set the
    // agent to Completed (and written output) before this HTTP call arrived,
    // so we skip the write but MUST NOT skip the consultation resolution below.
    if (agent.status !== AgentStatus.Completed) {
      await this.agentRepo.update(agentId, {
        status: AgentStatus.Completed,
        output,
      });
      this.logger.log(`Agent ${agentId} completed`);
    }

    // Always attempt consultation resolution even if status was already
    // Completed — the lcp-agent fallback path sets status synchronously
    // before this HTTP call arrives, leaving the consultation pending.
    const resolvedOutput = output || agent.output || '';
    const role = await this.roleRepo.findOneBy({ id: agent.roleId });

    // Terminal state_change for any client observing this agent (a chat agent
    // resumed in the worker, or a consultation agent being followed). Recorded
    // here — before the consultation early-return below — so every worker
    // completion reaches its watchers, regardless of the idempotency guard.
    await this.recordStatus(
      agentId,
      agent.companyId,
      role?.name ?? 'agent',
      AgentStatus.Completed,
      { reason: 'turn_complete', response: resolvedOutput },
    );

    const consultation = await this.consultRepo.findOne({
      where: { consultationAgentId: agentId, status: 'pending' },
    });
    if (!consultation) return;

    await this.consultRepo.update(consultation.id, {
      status: 'complete',
      result: resolvedOutput,
    });

    const calling = await this.agentRepo.findOneBy({
      id: consultation.callingAgentId,
    });
    if (calling?.status !== AgentStatus.Paused) return;

    // Ask the orchestrator to resume the calling agent — it will stay paused
    // if other requests are still outstanding, or aggregate every response
    // since the pause (including this one) if this was the last.
    // Fire-and-forget — DB state is already consistent; don't block on Redis.
    void this.orchestration
      .resumeAgent(consultation.callingAgentId)
      .then(() =>
        this.logger.log(
          `Resumed calling agent ${consultation.callingAgentId} with consultation result`,
        ),
      )
      .catch((err: unknown) =>
        this.logger.error(
          `Failed to resume calling agent ${consultation.callingAgentId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /**
   * Marks an agent run as {@link AgentStatus.Failed} with the given reason.
   * If the agent was performing a consultation, resolves the pending record as
   * `failed` (storing the reason as its result) and re-enqueues the calling
   * agent so it can decide how to proceed rather than wait forever.
   *
   * Does not overwrite a Completed agent — `complete_task` may have won the
   * race against the failure notification.
   */
  async failAgent(agentId: UUID, reason: string): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) return;

    if (agent.status !== AgentStatus.Completed) {
      await this.agentRepo.update(agentId, { status: AgentStatus.Failed });
      this.logger.warn(`Agent ${agentId} failed: ${reason}`);
    }

    // Terminal state_change for observers — recorded before the consultation
    // early-return so every worker failure reaches its watchers.
    const role = await this.roleRepo.findOneBy({ id: agent.roleId });
    await this.recordStatus(
      agentId,
      agent.companyId,
      role?.name ?? 'agent',
      AgentStatus.Failed,
      { reason },
    );

    const consultation = await this.consultRepo.findOne({
      where: { consultationAgentId: agentId, status: 'pending' },
    });
    if (!consultation) return;

    await this.consultRepo.update(consultation.id, {
      status: 'failed',
      result: reason,
    });

    const calling = await this.agentRepo.findOneBy({
      id: consultation.callingAgentId,
    });
    if (calling?.status !== AgentStatus.Paused) return;

    // Same resume contract as completeAgent: the orchestrator aggregates all
    // responses (including this failure) once nothing else is outstanding.
    // Fire-and-forget — DB state is already consistent; don't block on Redis.
    void this.orchestration
      .resumeAgent(consultation.callingAgentId)
      .then(() =>
        this.logger.log(
          `Resumed calling agent ${consultation.callingAgentId} after consultation failure`,
        ),
      )
      .catch((err: unknown) =>
        this.logger.error(
          `Failed to resume calling agent ${consultation.callingAgentId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }

  /**
   * Merges a storage change snapshot into {@link LcpAgent.storageChanges}.
   * Called fire-and-forget by lcp-agent after each storage tool result.
   * Appends to existing arrays; does not deduplicate.
   */
  async updateStorageChanges(
    agentId: UUID,
    patch: {
      created?: string[];
      modified?: string[];
      deleted?: string[];
      moved?: { from: string; to: string }[];
    },
  ): Promise<void> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) return;

    const existing = agent.storageChanges ?? {
      created: [],
      modified: [],
      deleted: [],
      moved: [],
    };

    await this.agentRepo.update(agentId, {
      storageChanges: {
        created: [...existing.created, ...(patch.created ?? [])],
        modified: [...existing.modified, ...(patch.modified ?? [])],
        deleted: [...existing.deleted, ...(patch.deleted ?? [])],
        moved: [...existing.moved, ...(patch.moved ?? [])],
      },
    });
  }

  private async loadAgent(agentId: UUID): Promise<LcpAgent> {
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) throw new NotFoundException(`Agent ${agentId} not found`);
    return agent;
  }
}
