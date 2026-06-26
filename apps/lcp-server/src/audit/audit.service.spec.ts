import { AuditEvent, AuditEventType } from '@lcp/shared';
import { randomUUID } from 'crypto';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  let service: AuditService;
  let savedEvents: AuditEvent[];
  let mockRepo: { create: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    savedEvents = [];
    mockRepo = {
      create: jest.fn().mockImplementation(() => new AuditEvent()),
      save: jest.fn().mockImplementation((e: AuditEvent) => {
        savedEvents.push(e);
        return Promise.resolve(e);
      }),
    };
    service = new AuditService(mockRepo as never);
  });

  it('calls repo.save with correct fields via write()', async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

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

  it('sets agentId to null when omitted from write()', async () => {
    await service.write({
      companyId: randomUUID(),
      role: 'r',
      eventType: AuditEventType.Decision,
      payload: {},
    });

    expect(savedEvents[0].agentId).toBeNull();
  });
});
