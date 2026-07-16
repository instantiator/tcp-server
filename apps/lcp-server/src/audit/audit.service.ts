import { AuditEvent, AuditEventType, LcpAgent } from '@lcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { FindOptionsWhere, In, Repository } from 'typeorm';
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
    @InjectRepository(LcpAgent)
    private readonly agentRepo: Repository<LcpAgent>,
  ) {}

  /**
   * Persists a single audit event row. `assignmentId` is derived from the
   * agent's current assignment (not accepted from callers) so it can never
   * drift from the source of truth on `lcp_agent`.
   */
  async write(dto: CreateAuditEventDto): Promise<void> {
    const event = this.repo.create();
    event.companyId = dto.companyId;
    event.role = dto.role;
    event.agentId = dto.agentId ?? null;
    event.assignmentId = dto.agentId
      ? ((await this.agentRepo.findOneBy({ id: dto.agentId }))?.assignmentId ??
        null)
      : null;
    event.eventType = dto.eventType;
    event.payload = dto.payload;
    await this.repo.save(event);
  }

  async record(
    companyId: UUID,
    role: string,
    agentId: UUID | null,
    eventType: AuditEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.write({
      companyId,
      role,
      agentId: agentId ?? undefined,
      eventType,
      payload,
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
}
