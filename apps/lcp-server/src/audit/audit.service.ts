import {
  AuditEvent,
  AuditEventType,
  TcpAgent,
  TcpAssignment,
} from '@lcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { FindOptionsWhere, In, Repository } from 'typeorm';
import { AuditEventPublisher } from '../events/audit-event-publisher.service';
import { CreateAuditEventDto } from './create-audit-event.dto';

/**
 * Writes {@link AuditEvent} rows to the database.
 *
 * Used directly by services within lcp-server (e.g. {@link ChatService}) and
 * exposed via {@link AuditController} for external callers such as lcp-agent
 * and the MCP servers.
 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditEvent)
    private readonly repo: Repository<AuditEvent>,
    @InjectRepository(TcpAgent)
    private readonly agentRepo: Repository<TcpAgent>,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    private readonly publisher: AuditEventPublisher,
  ) {}

  /**
   * Persists a single audit event row. When the row has an `agentId`, its
   * `assignmentId`/`taskId` are derived from the agent's current assignment
   * (caller-supplied ids are ignored) so they can never drift from the source
   * of truth. Agent-less orchestrator/company rows take the DTO's explicit
   * `assignmentId`/`taskId`.
   */
  async write(dto: CreateAuditEventDto): Promise<void> {
    const event = this.repo.create();
    event.companyId = dto.companyId;
    event.role = dto.role;
    event.agentId = dto.agentId ?? null;

    if (dto.agentId) {
      const assignmentId =
        (await this.agentRepo.findOneBy({ id: dto.agentId }))?.assignmentId ??
        null;
      event.assignmentId = assignmentId;
      event.taskId = assignmentId
        ? ((await this.assignmentRepo.findOneBy({ id: assignmentId }))
            ?.taskId ?? null)
        : null;
    } else {
      event.assignmentId = dto.assignmentId ?? null;
      event.taskId = dto.taskId ?? null;
    }

    event.eventType = dto.eventType;
    event.payload = dto.payload;
    const saved = await this.repo.save(event);
    // Persist-then-publish: the same row that history reads is streamed live.
    this.publisher.publish(saved);
  }

  async record(
    companyId: UUID,
    role: string,
    agentId: UUID | null,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
    ids?: { assignmentId?: UUID | null; taskId?: UUID | null },
  ): Promise<void> {
    await this.write({
      companyId,
      role,
      agentId: agentId ?? undefined,
      eventType,
      payload,
      assignmentId: ids?.assignmentId ?? undefined,
      taskId: ids?.taskId ?? undefined,
    });
  }

  /**
   * Lists a company's audit events, oldest first — optionally scoped to a
   * given set of agent ids (e.g. the assignments belonging to a task).
   * Backs history reconstruction for `lcp-cli eavesdrop --show-history`.
   */
  async list(companyId: UUID, agentIds?: UUID[]): Promise<AuditEvent[]> {
    const where: FindOptionsWhere<AuditEvent> = {
      companyId,
      ...(agentIds && agentIds.length > 0 ? { agentId: In(agentIds) } : {}),
    };
    return this.repo.find({ where, order: { timestamp: 'ASC' } });
  }

  /** Lists a company's audit events scoped to a given set of assignment ids. */
  async listByAssignments(
    companyId: UUID,
    assignmentIds: UUID[],
  ): Promise<AuditEvent[]> {
    return this.repo.find({
      where: { companyId, assignmentId: In(assignmentIds) },
      order: { timestamp: 'ASC' },
    });
  }

  /**
   * Lists a task's audit events, oldest first — every row denormalised to that
   * `taskId`, including agent-less orchestrator rows the assignments→agents
   * join used to miss. Backs {@link TaskService.getHistory}.
   */
  async listByTask(companyId: UUID, taskId: UUID): Promise<AuditEvent[]> {
    return this.repo.find({
      where: { companyId, taskId },
      order: { timestamp: 'ASC' },
    });
  }
}
