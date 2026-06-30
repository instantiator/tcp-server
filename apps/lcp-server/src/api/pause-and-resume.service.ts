import {
  AgentStatus,
  LcpAgent,
  LcpRole,
  PendingConsultation,
} from '@lcp/shared';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { Repository } from 'typeorm';
import { AgentOrchestrationService } from './agent-orchestration.service';
import { ConversationService } from './conversation.service';

const CONSULTATION_PROMPT_SUFFIX = [
  '',
  'This is a consultation request from another agent. Provide a complete, concise answer.',
  'If you create output files, reference them in your final answer.',
  'Call `interactions__complete_task` with your final answer when done.',
].join('\n');

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
  ) {}

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

    // Build the consulting agent's prompt and dispatch it.
    const callingRole = await this.roleRepo.findOneBy({
      id: callingAgent.roleId,
    });
    const initialPrompt = [
      context ? `Context: ${context}` : null,
      `Question: ${question}`,
      CONSULTATION_PROMPT_SUFFIX,
    ]
      .filter(Boolean)
      .join('\n');

    const consultAgent = await this.orchestration.startAgent({
      companyId,
      roleId: role.id,
      initialPrompt,
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
    // Mark this agent completed — a no-op if already completed.
    const agent = await this.agentRepo.findOneBy({ id: agentId });
    if (!agent) return;
    if (agent.status === AgentStatus.Completed) return; // idempotent

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Completed,
      output,
    });
    this.logger.log(`Agent ${agentId} completed`);

    // If this was a consultation agent, resolve the pending record so the
    // calling agent's resume can pick up the result.
    const consultation = await this.consultRepo.findOne({
      where: { consultationAgentId: agentId, status: 'pending' },
    });
    if (!consultation) return;

    await this.consultRepo.update(consultation.id, {
      status: 'complete',
      result: output,
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
