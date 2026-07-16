import { AuditEvent, AuditEventType, LcpAgent } from '@lcp/shared';
import { randomUUID } from 'crypto';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  let savedEvents: AuditEvent[];
  let mockRepo: { create: jest.Mock; save: jest.Mock; find: jest.Mock };
  let mockAgentRepo: { findOneBy: jest.Mock };
  let agents: Record<string, Pick<LcpAgent, 'assignmentId'>>;

  beforeEach(() => {
    savedEvents = [];
    agents = {};
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
    service = new AuditService(mockRepo as never, mockAgentRepo as never);
  });

  it('calls repo.save with correct fields via write()', async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const assignmentId = randomUUID();
    agents[agentId] = { assignmentId };

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
    expect(saved.eventType).toBe(AuditEventType.LlmRequest);
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
});
