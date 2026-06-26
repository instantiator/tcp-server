import { AuditEventType } from '@lcp/shared';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AuditClientService } from './audit-client.service';

jest.mock('axios');
let mockedPost: jest.SpyInstance;

function makeService(
  serverUrl = 'http://lcp-server:3000',
  apiKey = 'key',
): AuditClientService {
  const config = {
    getOrThrow: jest
      .fn()
      .mockImplementation((key: string) =>
        key === 'LCP_SERVER_URL' ? serverUrl : apiKey,
      ),
  } as unknown as ConfigService;
  return new AuditClientService(config);
}

describe('AuditClientService', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    mockedPost = jest.spyOn(axios, 'post').mockResolvedValue({ status: 204 });
  });

  afterEach(() => jest.clearAllMocks());

  it('posts to /internal/audit with correct headers', () => {
    const service = makeService();

    service.record(
      'company-id',
      'analyst',
      'agent-id',
      AuditEventType.LlmRequest,
      { msg: 'hi' },
    );

    expect(mockedPost).toHaveBeenCalledWith(
      'http://lcp-server:3000/internal/audit',
      expect.objectContaining({ eventType: AuditEventType.LlmRequest }),
      expect.objectContaining({ headers: { 'X-Internal-Api-Key': 'key' } }),
    );
  });

  it('logs and swallows HTTP errors', async () => {
    mockedPost.mockRejectedValue(new Error('network error'));
    const service = makeService();

    // Should not throw — fire and forget
    service.record('c', 'r', null, AuditEventType.Decision, {});

    // Yield microtask queue so the rejected promise is caught
    await new Promise((r) => setTimeout(r, 0));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('network error'),
    );
  });
});
