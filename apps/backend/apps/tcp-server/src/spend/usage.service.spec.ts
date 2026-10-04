import { AuditEvent } from '@tcp/shared';
import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { UsageService } from './usage.service';

function makeEvent(payload: Record<string, unknown>): AuditEvent {
  const event = new AuditEvent();
  event.companyId = randomUUID();
  event.taskId = randomUUID();
  event.agentId = randomUUID();
  event.payload = payload;
  return event;
}

describe('UsageService', () => {
  let insert: jest.Mock;
  let service: UsageService;

  beforeEach(() => {
    insert = jest.fn().mockResolvedValue(undefined);
    service = new UsageService({ insert } as never);
  });

  it('inserts a token_usage row with the audit row ids when payload.usage is valid', async () => {
    const event = makeEvent({
      usage: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        inputTokens: 100,
        outputTokens: 20,
      },
    });

    await service.record(event);

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith({
      companyId: event.companyId,
      taskId: event.taskId,
      agentId: event.agentId,
      provider: 'lm-studio',
      model: 'qwen3-5b',
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('inserts nothing when the payload has no usage', async () => {
    const event = makeEvent({ responseText: 'hi' });

    await service.record(event);

    expect(insert).not.toHaveBeenCalled();
  });

  it('inserts nothing when payload.usage is malformed', async () => {
    const event = makeEvent({ usage: { provider: 'lm-studio' } });

    await service.record(event);

    expect(insert).not.toHaveBeenCalled();
  });

  it('swallows and logs a repo error instead of throwing', async () => {
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    insert.mockRejectedValue(new Error('insert failed'));
    const event = makeEvent({
      usage: {
        provider: 'lm-studio',
        model: 'qwen3-5b',
        inputTokens: 1,
        outputTokens: 1,
      },
    });

    await expect(service.record(event)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
