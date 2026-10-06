import {
  AgentStatus,
  TcpAgent,
  TcpAssignment,
  requiredToolForMode,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { UUID } from 'crypto';
import { DataSource, FindOptionsWhere, In, Repository } from 'typeorm';
import { TcpAgentTemplate } from '../templates/TcpAgentTemplate';

/**
 * Agent statuses counted as "active" — the non-terminal ones. Shared by
 * {@link AgentDbService.list}'s default filter and the company statistics, so
 * a company's `activeAgents` count can never disagree with its agent list.
 */
export const ACTIVE_AGENT_STATUSES = [
  AgentStatus.Idle,
  AgentStatus.Queued,
  AgentStatus.Running,
  AgentStatus.Paused,
] as const;

/** TypeORM operations for {@link TcpAgent}, behind {@link DbService}. */
@Injectable()
export class AgentDbService {
  constructor(
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Creates a new {@link TcpAgent} in the `idle` state, always with an
   * assignment. When `template.assignmentId` is given the agent attaches to
   * that existing assignment; otherwise an orphan assignment is created first
   * — in `template.mode ?? 'implement'` mode, carrying the agent's
   * `initialPrompt` — and the two are cross-linked. When `template.parentAssignmentId`
   * is also given, the orphan inherits that parent's `taskId` and records the
   * link (so e.g. a consultation traces back to the task that spawned it);
   * otherwise the orphan is fully parentless/taskless (top-level agents — planner
   * dispatch, the standalone `chat` command). The agent's
   * `initialPrompt`/`requiredToolCalls` are populated from the template
   * (010.1.2 copy semantics); `requiredToolCalls` defaults to the mode's
   * required tool ({@link requiredToolForMode}).
   *
   * Wrapped in a transaction so an agent never persists without its
   * assignment (nor an orphan assignment without its back-linked agent).
   */
  async create(template: TcpAgentTemplate): Promise<TcpAgent> {
    const mode = template.mode ?? 'implement';
    return this.dataSource.transaction(async (em) => {
      const assignmentRepo = em.getRepository(TcpAssignment);
      const agentRepo = em.getRepository(TcpAgent);

      // Orphan assignment first (agentId back-filled after the agent exists).
      const isOrphan = template.assignmentId === undefined;
      let assignmentId: UUID;
      if (template.assignmentId !== undefined) {
        assignmentId = template.assignmentId;
      } else {
        const parent = template.parentAssignmentId
          ? await assignmentRepo.findOneBy({ id: template.parentAssignmentId })
          : null;
        const assignment = await assignmentRepo.save(
          assignmentRepo.create({
            taskId: parent?.taskId ?? null,
            companyId: template.companyId,
            mode,
            prompt: template.initialPrompt,
            roleId: template.roleId,
            status: 'in-progress',
            agentId: null,
            parentAssignmentId: template.parentAssignmentId ?? null,
            materials: [],
            expected: [],
          }),
        );
        assignmentId = assignment.id;
      }

      const agent = await agentRepo.save(
        agentRepo.create({
          companyId: template.companyId,
          roleId: template.roleId,
          initialPrompt: template.initialPrompt,
          requiredToolCalls:
            template.requiredToolCalls ?? requiredToolForMode(mode),
          assignmentId,
        }),
      );

      // Back-link the orphan assignment to the agent now working it.
      if (isOrphan) {
        await assignmentRepo.update(assignmentId, { agentId: agent.id });
      }

      return agent;
    });
  }

  /** Retrieves an agent by its UUID. Returns `null` if not found. */
  async get(id: UUID): Promise<TcpAgent | null> {
    return this.agentRepo.findOneBy({ id });
  }

  /**
   * Lists agents filtered by company, role, and/or assignment, and/or
   * status; any combination may be given. `status` defaults to currently
   * active agents (`idle`, `running`, `paused`) when omitted — a
   * general-purpose observability listing wants live agents by default, not
   * the (usually much larger) set of finished ones.
   */
  async list(filter: {
    companyId?: UUID;
    roleId?: UUID;
    assignmentId?: UUID;
    status?: AgentStatus;
  }): Promise<TcpAgent[]> {
    const where: FindOptionsWhere<TcpAgent> = {
      ...(filter.companyId ? { companyId: filter.companyId } : {}),
      ...(filter.roleId ? { roleId: filter.roleId } : {}),
      ...(filter.assignmentId ? { assignmentId: filter.assignmentId } : {}),
      status: filter.status ?? In([...ACTIVE_AGENT_STATUSES]),
    };
    return this.agentRepo.find({ where, order: { createdAt: 'DESC' } });
  }

  /**
   * Physically deletes an {@link TcpAgent} and its associated audit-event rows.
   * Returns `true` if a record was deleted, `false` if no agent with that id exists.
   */
  async delete(id: UUID): Promise<boolean> {
    const result = await this.agentRepo.delete(id);
    return (result.affected ?? 0) > 0;
  }

  /**
   * Updates the status of an {@link TcpAgent}, and optionally sets its
   * LangGraph `threadId` on first dispatch.
   */
  async updateStatus(
    id: UUID,
    status: AgentStatus,
    threadId?: string,
  ): Promise<void> {
    await this.agentRepo.update(id, {
      status,
      ...(threadId !== undefined && { threadId }),
    });
  }
}
