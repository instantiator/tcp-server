import {
  AuditEventType,
  TcpCompany,
  TcpNotification,
  type NotificationKind,
  type NotificationSeverity,
} from '@tcp/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { UUID } from 'crypto';
import {
  FindOptionsWhere,
  IsNull,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { CompanyEventService } from '../events/company-event.service';

/** What a caller supplies to raise a {@link TcpNotification}. */
export interface NewNotification {
  severity: NotificationSeverity;
  kind: NotificationKind;
  message: string;
  params?: Record<string, unknown>;
  /** Raise at most once per key — a repeat is silently ignored. */
  dedupeKey?: string;
  /** For a task notice: its company, which alone sees it. */
  companyId?: UUID;
  /** For a task notice: the task, to link to. */
  taskId?: UUID;
}

/** The most notifications one list call returns, newest first. */
const LIST_LIMIT = 200;

/** Postgres' unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

/**
 * Raises, lists and dismisses {@link TcpNotification}s, and pushes every
 * change onto the SSE channel of each company that may see it — every
 * company for an application-wide notice, one for a company's own — so any
 * open company page sees it live.
 *
 * Notifications are not audit rows: they belong to no company, and the
 * `notification` table is already their durable record. The live event is
 * therefore synthesized (no `id`), like a priming event.
 */
@Injectable()
export class NotificationService {
  constructor(
    @InjectRepository(TcpNotification)
    private readonly repo: Repository<TcpNotification>,
    @InjectRepository(TcpCompany)
    private readonly companyRepo: Repository<TcpCompany>,
    private readonly companyEvents: CompanyEventService,
  ) {}

  /**
   * Raises a notification and broadcasts it.
   *
   * @returns The new row, or null when `dedupeKey` was already used — so
   *   concurrent callers racing on the same condition raise it once.
   */
  async create(input: NewNotification): Promise<TcpNotification | null> {
    let saved: TcpNotification;
    try {
      saved = await this.repo.save(this.repo.create(input));
    } catch (err) {
      if (input.dedupeKey && isUniqueViolation(err)) return null;
      throw err;
    }
    await this.broadcast(saved);
    return saved;
  }

  /**
   * Lists application-wide notifications, newest first; dismissed ones only
   * on request. Never a company's own notices: this list has no member to
   * show them to.
   */
  list(includeDismissed = false): Promise<TcpNotification[]> {
    return this.find([{ companyId: IsNull() }], includeDismissed);
  }

  /** Lists the application-wide notifications plus one company's own. */
  listForCompany(
    companyId: UUID,
    includeDismissed = false,
  ): Promise<TcpNotification[]> {
    return this.find(
      [{ companyId: IsNull() }, { companyId }],
      includeDismissed,
    );
  }

  /** Finds one notification, to check who may act on it. */
  findOne(id: UUID): Promise<TcpNotification | null> {
    return this.repo.findOneBy({ id });
  }

  /** Lists the rows matching any of `scopes`, newest first. */
  private find(
    scopes: FindOptionsWhere<TcpNotification>[],
    includeDismissed: boolean,
  ): Promise<TcpNotification[]> {
    const where = includeDismissed
      ? scopes
      : scopes.map((scope) => ({ ...scope, dismissedAt: IsNull() }));
    return this.repo.find({
      where,
      order: { createdAt: 'DESC' },
      take: LIST_LIMIT,
    });
  }

  /**
   * Dismisses a notification for everyone. Idempotent: dismissing it again
   * returns the row unchanged and broadcasts nothing.
   */
  async dismiss(id: UUID): Promise<TcpNotification> {
    const notification = await this.repo.findOneBy({ id });
    if (!notification) {
      throw new NotFoundException(`Notification ${id} not found`);
    }
    if (notification.dismissedAt) return notification;

    notification.dismissedAt = new Date();
    const saved = await this.repo.save(notification);
    await this.broadcast(saved);
    return saved;
  }

  /**
   * Sends a notification's current state to every company's channel.
   * ponytail: one emit per company; fine for a home install's handful of
   * companies — add an application-wide channel if that grows large.
   */
  private async broadcast(notification: TcpNotification): Promise<void> {
    // A company's own notice goes to that company's channel alone.
    const companies = notification.companyId
      ? [{ id: notification.companyId }]
      : await this.companyRepo.find({ select: { id: true } });
    const timestamp = new Date().toISOString();
    for (const { id: companyId } of companies) {
      this.companyEvents.emit(companyId, {
        type: 'audit',
        event: {
          timestamp,
          companyId,
          role: 'system',
          agentId: null,
          assignmentId: null,
          taskId: null,
          eventType: AuditEventType.StateChange,
          payload: notificationPayload(notification, 'change'),
        },
      });
    }
  }
}

/**
 * The `state_change` payload for a notification, shared by the live
 * broadcast and company priming so both carry the same summary shape.
 */
export function notificationPayload(
  notification: TcpNotification,
  reason: 'change' | 'replay',
): Record<string, unknown> {
  return {
    entity: 'notification',
    newStatus: notification.dismissedAt ? 'dismissed' : 'active',
    reason,
    summary: notification,
  };
}

/** True when `err` is a database unique-constraint violation. */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const code: unknown = (err.driverError as { code?: unknown } | undefined)
    ?.code;
  return code === UNIQUE_VIOLATION;
}
