import { AuditEvent, AuditEventType } from '@tcp/shared';
import { randomUUID } from 'crypto';
import { AgentEventService } from './agent-event.service';
import { AuditEventPublisher } from './audit-event-publisher.service';
import { CompanyEventService } from './company-event.service';
import { TaskEventService } from './task-event.service';

const companyId = randomUUID();
const agentId = randomUUID();
const taskId = randomUUID();

/** A persisted audit row, with the routing-relevant fields overridable. */
const row = (overrides: Partial<AuditEvent> = {}): AuditEvent =>
  ({
    id: randomUUID(),
    timestamp: new Date(),
    companyId,
    role: 'system',
    agentId: null,
    assignmentId: null,
    taskId: null,
    eventType: AuditEventType.StateChange,
    payload: {},
    ...overrides,
  }) as AuditEvent;

describe('AuditEventPublisher', () => {
  let agentEvents: jest.Mocked<Pick<AgentEventService, 'emit'>>;
  let taskEvents: jest.Mocked<Pick<TaskEventService, 'emit'>>;
  let companyEvents: jest.Mocked<Pick<CompanyEventService, 'emit'>>;
  let publisher: AuditEventPublisher;

  beforeEach(() => {
    agentEvents = { emit: jest.fn() };
    taskEvents = { emit: jest.fn() };
    companyEvents = { emit: jest.fn() };
    publisher = new AuditEventPublisher(
      agentEvents as unknown as AgentEventService,
      taskEvents as unknown as TaskEventService,
      companyEvents as unknown as CompanyEventService,
    );
  });

  describe('company channel', () => {
    // The web UI's live activity view renders a list per entity; an entity
    // missing here is a list that silently never updates (ADR-023).
    it.each(['company', 'task', 'agent', 'assignment', 'enquiry'])(
      'routes a %p row to the company stream',
      (entity) => {
        publisher.publish(row({ payload: { entity } }));
        expect(companyEvents.emit).toHaveBeenCalledWith(
          companyId,
          expect.objectContaining({ type: 'audit' }),
        );
      },
    );

    it('does not route an unknown entity', () => {
      publisher.publish(row({ payload: { entity: 'knowledge' } }));
      expect(companyEvents.emit).not.toHaveBeenCalled();
    });

    it('does not route a row with no entity at all', () => {
      publisher.publish(row({ payload: { message: 'hello' } }));
      expect(companyEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('agent channel', () => {
    it('routes any row carrying an agentId, whatever the entity', () => {
      publisher.publish(row({ agentId, payload: { entity: 'enquiry' } }));
      expect(agentEvents.emit).toHaveBeenCalledWith(
        agentId,
        expect.objectContaining({ type: 'audit' }),
      );
    });

    it('does not route a row without an agentId', () => {
      publisher.publish(row({ payload: { entity: 'agent' } }));
      expect(agentEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('task channel', () => {
    it.each(['task', 'assignment'])(
      'routes a %p row that carries a taskId',
      (entity) => {
        publisher.publish(row({ taskId, payload: { entity } }));
        expect(taskEvents.emit).toHaveBeenCalledWith(
          taskId,
          expect.objectContaining({ type: 'audit' }),
        );
      },
    );

    // The company-channel widening must not have widened this one too.
    it.each(['agent', 'enquiry', 'company'])(
      'does not route a %p row even with a taskId',
      (entity) => {
        publisher.publish(row({ taskId, payload: { entity } }));
        expect(taskEvents.emit).not.toHaveBeenCalled();
      },
    );

    it('does not route a task row without a taskId', () => {
      publisher.publish(row({ payload: { entity: 'task' } }));
      expect(taskEvents.emit).not.toHaveBeenCalled();
    });
  });

  describe('records changes (001.05)', () => {
    const update = {
      source: 'records',
      action: 'update',
      table: 'orders',
      recordId: 'r1',
      before: { name: 'Ann Lee' },
      after: { name: 'Ann Lee-Smith' },
      userId: 'u1',
    };

    // The audit row holds customer data; the browser only needs to know
    // which table to look at again.
    it('sends the company stream only the table and the action', () => {
      publisher.publish(row({ payload: update }));
      expect(companyEvents.emit).toHaveBeenCalledTimes(1);
      const [, sent] = companyEvents.emit.mock.calls[0];
      expect(sent.type === 'audit' && sent.event.payload).toEqual({
        entity: 'record',
        action: 'update',
        table: 'orders',
      });
    });

    it('sends a do-not-store change without a table', () => {
      publisher.publish(
        row({
          payload: {
            source: 'records',
            action: 'do_not_store_add',
            entryId: 'e1',
          },
        }),
      );
      const [, sent] = companyEvents.emit.mock.calls[0];
      expect(sent.type === 'audit' && sent.event.payload).toEqual({
        entity: 'record',
        action: 'do_not_store_add',
      });
    });

    it('does not send a read', () => {
      publisher.publish(
        row({
          eventType: AuditEventType.ToolCall,
          payload: { source: 'records', action: 'query', table: 'orders' },
        }),
      );
      expect(companyEvents.emit).not.toHaveBeenCalled();
    });

    it('still sends the agent stream the full change', () => {
      publisher.publish(row({ agentId, payload: update }));
      const [id, sent] = agentEvents.emit.mock.calls[0];
      expect(id).toBe(agentId);
      expect(sent.type === 'audit' && sent.event.payload).toEqual(update);
    });
  });
});
