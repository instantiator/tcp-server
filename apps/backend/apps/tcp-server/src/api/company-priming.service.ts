import {
  AuditEventType,
  buildAgentChangeSummary,
  buildAssignmentChangeSummary,
  buildEnquiryChangeSummary,
  TcpAssignment,
  WireEvent,
} from '@tcp/shared';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import {
  NotificationService,
  notificationPayload,
} from '../notifications/notification.service';
import { ConversationService } from './conversation.service';
import { TaskService } from './task.service';

/**
 * Builds the priming {@link WireEvent}s a late subscriber to
 * `GET /api/company/:id/events` receives before any live row: the company
 * signal, then the current state of each list the web UI renders — tasks,
 * active agents, open consultations and open enquiries (ADR-023) — and the
 * active application-wide notifications.
 *
 * Every event is a synthesized `state_change` with `reason: 'replay'` and no
 * `id` (nothing was persisted), and each carries the **same summary shape**
 * the live path emits for that entity — a list built from priming would
 * otherwise disagree with its own first update.
 */
@Injectable()
export class CompanyPrimingService {
  constructor(
    private readonly tasks: TaskService,
    private readonly db: DbService,
    @InjectRepository(TcpAssignment)
    private readonly assignmentRepo: Repository<TcpAssignment>,
    private readonly conversations: ConversationService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Builds the priming events for one company, in list order: company, tasks,
   * active agents, consultations, open enquiries, active notifications. All
   * share one timestamp —
   * they describe a single moment, not a sequence.
   */
  async prime(companyId: UUID): Promise<WireEvent[]> {
    const timestamp = new Date().toISOString();
    const [taskSummaries, agents, consultations, enquiries, roles, notices] =
      await Promise.all([
        this.tasks.listChangeSummaries(companyId),
        this.db.listAgents({ companyId }),
        this.assignmentRepo.find({
          where: { companyId, taskId: IsNull(), mode: 'consultee' },
        }),
        this.conversations.list(companyId, 'awaiting_user'),
        this.db.listRoles(companyId),
        this.notifications.listForCompany(companyId),
      ]);

    // One lookup for every role name the agent and consultation rows need,
    // rather than a query per row.
    const roleNames = new Map(roles.map((role) => [role.id, role.name]));
    const roleName = (roleId: UUID | null): string =>
      (roleId ? roleNames.get(roleId) : undefined) ?? 'agent';

    return [
      {
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: 'system',
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: { entity: 'company', reason: 'replay' },
        },
      },
      ...taskSummaries.map((summary): WireEvent => ({
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: 'orchestrator',
          agentId: null,
          assignmentId: null,
          taskId: summary.id,
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'task',
            newStatus: summary.status,
            reason: 'replay',
            summary,
          },
        },
      })),
      ...agents.map((agent): WireEvent => ({
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: roleName(agent.roleId),
          agentId: agent.id,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'agent',
            newStatus: agent.status,
            reason: 'replay',
            summary: buildAgentChangeSummary(agent),
          },
        },
      })),
      ...consultations.map((assignment): WireEvent => ({
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: roleName(assignment.roleId),
          agentId: null,
          assignmentId: assignment.id,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'assignment',
            newStatus: assignment.status,
            reason: 'replay',
            summary: buildAssignmentChangeSummary(assignment),
          },
        },
      })),
      ...enquiries.map((conv): WireEvent => ({
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: conv.roleName,
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: {
            entity: 'enquiry',
            newStatus: conv.status,
            reason: 'replay',
            summary: buildEnquiryChangeSummary(conv),
          },
        },
      })),
      ...notices.map((notice): WireEvent => ({
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: 'system',
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: notificationPayload(notice, 'replay'),
        },
      })),
    ];
  }
}
