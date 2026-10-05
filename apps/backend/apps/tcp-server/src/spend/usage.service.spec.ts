import { AuditEvent, AuditEventType, TokenUsage } from '@tcp/shared';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { InsertResult, Repository } from 'typeorm';
import { CompanyEventService } from '../events/company-event.service';
import { SpendCapService } from './spend-cap.service';
import { UsageService } from './usage.service';

function makeEvent(payload: Record<string, unknown>): AuditEvent {
  const event = new AuditEvent();
  event.companyId = randomUUID();
  event.taskId = randomUUID();
  event.agentId = randomUUID();
  event.payload = payload;
  return event;
}

const usage = {
  provider: 'lm-studio',
  model: 'qwen3-5b',
  inputTokens: 100,
  outputTokens: 20,
};

describe('UsageService', () => {
  const createdAt = new Date('2026-10-04T12:00:00.000Z');
  let insert: jest.Mock<Promise<InsertResult>, [Partial<TokenUsage>]>;
  let caps: jest.Mocked<Pick<SpendCapService, 'onUsage' | 'onUntracked'>>;
  let companyEvents: jest.Mocked<Pick<CompanyEventService, 'emit'>>;
  let service: UsageService;

  beforeEach(() => {
    insert = jest.fn((_row: Partial<TokenUsage>) =>
      Promise.resolve({
        identifiers: [],
        generatedMaps: [{ createdAt }],
        raw: [],
      }),
    );
    caps = {
      onUsage: jest.fn().mockResolvedValue(undefined),
      onUntracked: jest.fn().mockResolvedValue(undefined),
    };
    companyEvents = { emit: jest.fn() };
    service = new UsageService(
      { insert } as unknown as Repository<TokenUsage>,
      caps as unknown as SpendCapService,
      companyEvents as unknown as CompanyEventService,
    );
  });

  it('inserts a token_usage row with the audit row ids when payload.usage is valid', async () => {
    const event = makeEvent({ usage });

    await service.record(event);

    expect(insert).toHaveBeenCalledWith({
      companyId: event.companyId,
      taskId: event.taskId,
      agentId: event.agentId,
      ...usage,
    });
  });

  it('hands the row to cap evaluation with its own timestamp and total tokens', async () => {
    await service.record(makeEvent({ usage }));

    expect(caps.onUsage).toHaveBeenCalledWith('lm-studio', createdAt, 120);
  });

  it('announces a spend change on the row’s company channel, once per recorded row', async () => {
    const event = makeEvent({ usage });

    await service.record(event);

    expect(companyEvents.emit).toHaveBeenCalledTimes(1);
    expect(companyEvents.emit).toHaveBeenCalledWith(event.companyId, {
      type: 'audit',
      event: {
        timestamp: createdAt.toISOString(),
        companyId: event.companyId,
        role: 'system',
        agentId: null,
        assignmentId: null,
        taskId: null,
        eventType: AuditEventType.StateChange,
        payload: { entity: 'spend', reason: 'change' },
      },
    });
  });

  it('announces nothing when no row is recorded', async () => {
    await service.record(makeEvent({ responseText: 'hi' }));

    expect(companyEvents.emit).not.toHaveBeenCalled();
  });

  it('inserts nothing when the payload has no usage', async () => {
    await service.record(makeEvent({ responseText: 'hi' }));

    expect(insert).not.toHaveBeenCalled();
    expect(caps.onUsage).not.toHaveBeenCalled();
  });

  it('inserts nothing when payload.usage is malformed', async () => {
    await service.record(makeEvent({ usage: { provider: 'lm-studio' } }));

    expect(insert).not.toHaveBeenCalled();
  });

  it('reports a provider that sent no usage, once per provider', async () => {
    await service.record(makeEvent({ untrackedProvider: 'ollama' }));
    await service.record(makeEvent({ untrackedProvider: 'ollama' }));
    await service.record(makeEvent({ untrackedProvider: 'lm-studio' }));

    expect(caps.onUntracked.mock.calls).toEqual([['ollama'], ['lm-studio']]);
    expect(insert).not.toHaveBeenCalled();
  });

  it('swallows and logs a repo error instead of throwing', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    insert.mockRejectedValue(new Error('insert failed'));

    await expect(service.record(makeEvent({ usage }))).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(caps.onUsage).not.toHaveBeenCalled();
  });
});
