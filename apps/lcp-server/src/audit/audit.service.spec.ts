import {
  AuditEvent,
  AuditEventType,
  LcpAgent,
  LcpAssignment,
} from '@lcp/shared';
import { randomUUID } from 'crypto';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  let savedEvents: AuditEvent[];
  let mockRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let mockAgentRepo: { findOneBy: jest.Mock };
  let mockAssignmentRepo: { findOneBy: jest.Mock };
  let agents: Record<string, Pick<LcpAgent, 'assignmentId'>>;
  let assignments: Record<string, Pick<LcpAssignment, 'taskId'>>;

  beforeEach(() => {
    savedEvents = [];
    agents = {};
    assignments = {};
    mockRepo = {
      create: jest.fn().mockImplementation(() => new AuditEvent()),
      save: jest.fn().mockImplementation((e: AuditEvent) => {
        savedEvents.push(e);
        return Promise.resolve(e);
      }),
      find: jest.fn().mockImplementation(() => Promise.resolve(savedEvents)),
    };
    mockAgentRepo = {
      findOneBy: jest
        .fn()
        .mockImplementation(({ id }: { id: string }) =>
          Promise.resolve(agents[id] ?? null),
        ),
    };
    mockAssignmentRepo = {
      findOneBy: jest
        .fn()
        .mockImplementation(({ id }: { id: string }) =>
          Promise.resolve(assignments[id] ?? null),
        ),
    };
    service = new AuditService(
      mockRepo as never,
      mockAgentRepo as never,
      mockAssignmentRepo as never,
      { publish: jest.fn() } as never,
    );
  });

  it('calls repo.save with correct fields via write(), deriving assignmentId and taskId from the agent', async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const assignmentId = randomUUID();
    const taskId = randomUUID();
    agents[agentId] = { assignmentId };
    assignments[assignmentId] = { taskId };

    await service.write({
      companyId,
      role: 'analyst',
      agentId,
      eventType: AuditEventType.LlmRequest,
      payload: { message: 'hello' },
    });

    expect(mockRepo.save).toHaveBeenCalledTimes(1);
    const saved = savedEvents[0];
    expect(saved.companyId).toBe(companyId);
    expect(saved.agentId).toBe(agentId);
    expect(saved.assignmentId).toBe(assignmentId);
    expect(saved.taskId).toBe(taskId);
    expect(saved.eventType).toBe(AuditEventType.LlmRequest);
  });

  it('ignores caller-supplied ids when agentId is set (derivation wins)', async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const assignmentId = randomUUID();
    const taskId = randomUUID();
    agents[agentId] = { assignmentId };
    assignments[assignmentId] = { taskId };

    await service.write({
      companyId,
      role: 'analyst',
      agentId,
      assignmentId: randomUUID(),
      taskId: randomUUID(),
      eventType: AuditEventType.StateChange,
      payload: {},
    });

    const saved = savedEvents[0];
    expect(saved.assignmentId).toBe(assignmentId);
    expect(saved.taskId).toBe(taskId);
  });

  it('accepts explicit assignmentId and taskId for agent-less rows', async () => {
    const companyId = randomUUID();
    const assignmentId = randomUUID();
    const taskId = randomUUID();

    await service.write({
      companyId,
      role: 'orchestrator',
      assignmentId,
      taskId,
      eventType: AuditEventType.StateChange,
      payload: { entity: 'task' },
    });

    const saved = savedEvents[0];
    expect(saved.agentId).toBeNull();
    expect(saved.assignmentId).toBe(assignmentId);
    expect(saved.taskId).toBe(taskId);
  });

  it('delegates to write() via record()', async () => {
    const companyId = randomUUID();
    await service.record(companyId, 'dev', null, AuditEventType.StateChange, {
      newStatus: 'idle',
    });

    expect(mockRepo.save).toHaveBeenCalledTimes(1);
    const saved = savedEvents[0];
    expect(saved.agentId).toBeNull();
    expect(saved.role).toBe('dev');
  });

  it('sets agentId and assignmentId to null when omitted from write()', async () => {
    await service.write({
      companyId: randomUUID(),
      role: 'r',
      eventType: AuditEventType.Decision,
      payload: {},
    });

    expect(savedEvents[0].agentId).toBeNull();
    expect(savedEvents[0].assignmentId).toBeNull();
  });

  it('sets assignmentId to null when the given agent id is not found', async () => {
    await service.write({
      companyId: randomUUID(),
      role: 'r',
      agentId: randomUUID(),
      eventType: AuditEventType.Decision,
      payload: {},
    });

    expect(savedEvents[0].assignmentId).toBeNull();
  });

  it('listByAssignments filters saved rows by companyId and assignmentId', async () => {
    const companyId = randomUUID();
    const assignmentId = randomUUID();
    const agentId = randomUUID();
    agents[agentId] = { assignmentId };

    await service.write({
      companyId,
      role: 'r',
      agentId,
      eventType: AuditEventType.Decision,
      payload: {},
    });

    await service.listByAssignments(companyId, [assignmentId]);
    const call = mockRepo.find.mock.calls[0] as [
      { where: { companyId: string }; order: { timestamp: string } },
    ];
    expect(call[0].where.companyId).toBe(companyId);
    expect(call[0].order).toEqual({ timestamp: 'ASC' });
  });

  it('listByTask filters saved rows by companyId and taskId', async () => {
    const companyId = randomUUID();
    const taskId = randomUUID();

    await service.listByTask(companyId, taskId);
    const call = mockRepo.find.mock.calls[0] as [
      {
        where: { companyId: string; taskId: string };
        order: { timestamp: string };
      },
    ];
    expect(call[0].where.companyId).toBe(companyId);
    expect(call[0].where.taskId).toBe(taskId);
    expect(call[0].order).toEqual({ timestamp: 'ASC' });
  });
});
