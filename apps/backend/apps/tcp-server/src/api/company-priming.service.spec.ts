import {
  AgentStatus,
  AuditEventType,
  Conversation,
  TcpAgent,
  TcpAssignment,
  TcpNotification,
  TcpRole,
  WireEvent,
} from '@tcp/shared';
import { randomUUID } from 'crypto';
import { IsNull, Repository } from 'typeorm';
import { DbService } from '../db/db.service';
import { NotificationService } from '../notifications/notification.service';
import { CompanyPrimingService } from './company-priming.service';
import { ConversationService } from './conversation.service';
import { TaskService } from './task.service';

const companyId = randomUUID();
const roleId = randomUUID();

const taskSummary = {
  id: randomUUID(),
  status: 'ready' as const,
  request: 'Write a report',
  shortcode: '000',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedSteps: 0,
  totalSteps: 0,
};

const agent = {
  id: randomUUID(),
  companyId,
  roleId,
  status: AgentStatus.Running,
  assignmentId: randomUUID(),
} as TcpAgent;

const consultation = {
  id: randomUUID(),
  companyId,
  roleId,
  taskId: null,
  mode: 'consultee',
  status: 'in-progress',
  orderIndex: null,
} as TcpAssignment;

const enquiry = {
  id: randomUUID(),
  slug: 'analyst-1',
  companyId,
  roleName: 'Analyst',
  question: 'Which vendor?',
  status: 'awaiting_user',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
} as Conversation;

const notice = {
  id: randomUUID(),
  severity: 'warning',
  kind: 'spend_threshold',
  message: 'anthropic is at 80% of its monthly cap',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
} as TcpNotification;

/** The `payload.entity` of each primed event, in order. */
const entities = (events: WireEvent[]): unknown[] =>
  events.map((e) => (e.type === 'audit' ? e.event.payload.entity : e.type));

describe('CompanyPrimingService', () => {
  let tasks: jest.Mocked<Pick<TaskService, 'listChangeSummaries'>>;
  let db: jest.Mocked<Pick<DbService, 'listAgents' | 'listRoles'>>;
  let assignmentRepo: jest.Mocked<Pick<Repository<TcpAssignment>, 'find'>>;
  let conversations: jest.Mocked<Pick<ConversationService, 'list'>>;
  let notifications: jest.Mocked<Pick<NotificationService, 'listForCompany'>>;
  let service: CompanyPrimingService;

  beforeEach(() => {
    tasks = { listChangeSummaries: jest.fn().mockResolvedValue([]) };
    db = {
      listAgents: jest.fn().mockResolvedValue([]),
      listRoles: jest.fn().mockResolvedValue([]),
    };
    assignmentRepo = { find: jest.fn().mockResolvedValue([]) };
    conversations = { list: jest.fn().mockResolvedValue([]) };
    notifications = { listForCompany: jest.fn().mockResolvedValue([]) };
    service = new CompanyPrimingService(
      tasks as unknown as TaskService,
      db as unknown as DbService,
      assignmentRepo as unknown as Repository<TcpAssignment>,
      conversations as unknown as ConversationService,
      notifications as unknown as NotificationService,
    );
  });

  it('primes exactly one event for a company with nothing running', async () => {
    const events = await service.prime(companyId);
    expect(entities(events)).toEqual(['company']);
  });

  describe('with every list populated', () => {
    let events: WireEvent[];

    beforeEach(async () => {
      tasks.listChangeSummaries.mockResolvedValue([taskSummary]);
      db.listAgents.mockResolvedValue([agent]);
      db.listRoles.mockResolvedValue([
        { id: roleId, name: 'Analyst' } as TcpRole,
      ]);
      assignmentRepo.find.mockResolvedValue([consultation]);
      conversations.list.mockResolvedValue([enquiry]);
      notifications.listForCompany.mockResolvedValue([notice]);
      events = await service.prime(companyId);
    });

    it('primes all six groups in list order', () => {
      expect(entities(events)).toEqual([
        'company',
        'task',
        'agent',
        'assignment',
        'enquiry',
        'notification',
      ]);
    });

    it('replays only active notifications, with the row as their summary', () => {
      expect(notifications.listForCompany).toHaveBeenCalledWith(companyId);
      const replayed = events.at(-1);
      expect(replayed?.type === 'audit' && replayed.event.payload).toEqual({
        entity: 'notification',
        newStatus: 'active',
        reason: 'replay',
        summary: notice,
      });
    });

    it('queries only consultee orphan assignments', () => {
      expect(assignmentRepo.find).toHaveBeenCalledWith({
        where: { companyId, taskId: IsNull(), mode: 'consultee' },
      });
    });

    it('lists only enquiries awaiting a user', () => {
      expect(conversations.list).toHaveBeenCalledWith(
        companyId,
        'awaiting_user',
      );
    });

    it('attaches each entity’s summary, built by the shared builders', () => {
      const payloads = events.map((e) =>
        e.type === 'audit' ? e.event.payload : {},
      );
      expect(payloads[1].summary).toEqual(taskSummary);
      expect(payloads[2].summary).toEqual({
        id: agent.id,
        status: AgentStatus.Running,
        roleId,
        assignmentId: agent.assignmentId,
      });
      expect(payloads[3].summary).toEqual({
        id: consultation.id,
        status: 'in-progress',
        mode: 'consultee',
        orderIndex: null,
        roleId,
      });
      expect(payloads[4].summary).toEqual({
        id: enquiry.id,
        slug: 'analyst-1',
        status: 'awaiting_user',
        roleName: 'Analyst',
        question: 'Which vendor?',
        createdAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('marks every event as a replay state change with no persisted id', () => {
      for (const event of events) {
        expect(event.type).toBe('audit');
        if (event.type !== 'audit') continue;
        expect(event.event.id).toBeUndefined();
        expect(event.event.eventType).toBe(AuditEventType.StateChange);
        expect(event.event.payload.reason).toBe('replay');
      }
    });

    it('shares one timestamp — priming describes a moment, not a sequence', () => {
      const timestamps = new Set(
        events.map((e) => (e.type === 'audit' ? e.event.timestamp : e.type)),
      );
      expect(timestamps.size).toBe(1);
    });

    it('resolves role names from one listRoles call, not one per row', () => {
      expect(db.listRoles).toHaveBeenCalledTimes(1);
      const roles = events.map((e) => (e.type === 'audit' ? e.event.role : ''));
      expect(roles).toEqual([
        'system',
        'orchestrator',
        'Analyst',
        'Analyst',
        'Analyst',
        'system',
      ]);
    });
  });

  it('falls back to "agent" when a row’s role has since been deleted', async () => {
    db.listAgents.mockResolvedValue([agent]);
    db.listRoles.mockResolvedValue([]);
    const events = await service.prime(companyId);
    expect(events[1].type === 'audit' && events[1].event.role).toBe('agent');
  });
});
