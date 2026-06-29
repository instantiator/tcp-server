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
  ): Promise<{ slug: string }> {
    const agent = await this.loadAgent(agentId);
    const role = await this.roleRepo.findOneBy({ id: agent.roleId });

    await this.agentRepo.update(agentId, { status: AgentStatus.Paused });

    const conv = await this.convService.create(
      agent.companyId,
      agent.roleId,
      role?.name ?? 'agent',
      agentId,
      question,
      context,
    );

    this.logger.log(
      `Agent ${agentId} paused for user input — conversation ${conv.slug}`,
    );
    return { slug: conv.slug };
  }

  /**
   * Pauses the calling agent, starts a consultation agent for `roleName`, and
   * records the {@link PendingConsultation} link between them.
   * Returns the consultation id.
   */
  async pauseForConsultation(
    callingAgentId: UUID,
    companyId: UUID,
    roleName: string,
    question: string,
    context?: string,
  ): Promise<{ consultationId: UUID }> {
    const callingAgent = await this.loadAgent(callingAgentId);
    const role = await this.roleRepo.findOne({
      where: { companyId, name: roleName },
    });
    if (!role) {
      throw new NotFoundException(
        `No role named '${roleName}' found in company ${companyId}`,
      );
    }

    await this.agentRepo.update(callingAgentId, { status: AgentStatus.Paused });

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
      `Agent ${callingAgentId} (${callingRole?.name ?? '?'}) paused for consultation — consulting agent ${consultAgent.id} (${roleName}), consultation ${consultation.id}`,
    );
    return { consultationId: consultation.id };
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
    if (agent.status === AgentStatus.Completed) return; // idempotent

    await this.agentRepo.update(agentId, {
      status: AgentStatus.Completed,
      output,
    });
    this.logger.log(`Agent ${agentId} completed`);

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

    // Fire-and-forget — DB state is already consistent; don't block on Redis.
    void this.orchestration
      .resumeAgent(consultation.callingAgentId, output)
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
