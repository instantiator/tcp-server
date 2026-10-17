import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { LlmConfig } from '@tcp/shared';
import { DbService } from '../db/db.service';
import { LlmDestinationPolicy } from '../db/llm-destination-policy';
import { LlmModelsService } from './llm-models.service';

const LOCAL = { provider: 'lm-studio', baseUrl: 'http://localhost:1234/v1' };
const saved = (c: Partial<LlmConfig>): LlmConfig => ({
  ...LOCAL,
  model: 'm',
  ...c,
});

describe('LlmModelsService', () => {
  let service: LlmModelsService;
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const db = {
    getCompany: jest.fn(),
    findRoleByIdOrSlug: jest.fn(),
  };

  beforeEach(async () => {
    db.getCompany.mockResolvedValue({
      id: 'c1',
      llmConfig: saved({ apiKey: 'company-key' }),
      embeddingConfig: null,
    });
    db.findRoleByIdOrSlug.mockResolvedValue({
      llmConfig: saved({ apiKey: 'role-key' }),
    });
    const module = await Test.createTestingModule({
      providers: [
        LlmModelsService,
        LlmDestinationPolicy,
        { provide: DbService, useValue: db },
        {
          provide: ConfigService,
          useValue: new ConfigService({ LLM_ALLOWED_HOSTS: 'localhost' }),
        },
      ],
    }).compile();
    service = module.get(LlmModelsService);
    fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] })),
        ),
      );
  });

  afterEach(() => jest.restoreAllMocks());

  /** The Authorization header the one fetch carried. */
  const sentAuth = () =>
    (fetchSpy.mock.calls[0][1]?.headers as Record<string, string>)
      .Authorization;

  it('lists the ids from GET /models', async () => {
    await expect(service.list('c1', LOCAL)).resolves.toEqual(['a', 'b']);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:1234/v1/models');
  });

  it('refuses a remote provider without fetching', async () => {
    await expect(
      service.list('c1', {
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a host the policy does not allow, before fetching', async () => {
    await expect(
      service.list('c1', { ...LOCAL, baseUrl: 'http://10.0.0.5:1234/v1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends a typed key in preference to a saved one', async () => {
    await service.list('c1', { ...LOCAL, apiKey: 'typed' });
    expect(sentAuth()).toBe('Bearer typed');
  });

  it("uses the named role's saved key, then the company's", async () => {
    await service.list('c1', { ...LOCAL, roleId: 'r1' });
    expect(sentAuth()).toBe('Bearer role-key');
    fetchSpy.mockClear();
    await service.list('c1', LOCAL);
    expect(sentAuth()).toBe('Bearer company-key');
  });

  describe('without a company', () => {
    it('lists with no key, and never looks a saved one up', async () => {
      db.getCompany.mockClear();
      db.findRoleByIdOrSlug.mockClear();
      await expect(
        service.list(null, { ...LOCAL, roleId: 'r1' }),
      ).resolves.toEqual(['a', 'b']);
      expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({});
      expect(db.getCompany).not.toHaveBeenCalled();
      expect(db.findRoleByIdOrSlug).not.toHaveBeenCalled();
    });

    it('sends a typed key', async () => {
      await service.list(null, { ...LOCAL, apiKey: 'typed' });
      expect(sentAuth()).toBe('Bearer typed');
    });

    it('still refuses a host the policy does not allow', async () => {
      await expect(
        service.list(null, { ...LOCAL, baseUrl: 'http://10.0.0.5:1234/v1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  it('never sends a saved key to another address', async () => {
    await service.list('c1', {
      ...LOCAL,
      baseUrl: 'http://localhost:9999/v1',
    });
    expect(sentAuth()).toBeUndefined();
  });

  it('answers 502 when the server cannot be reached', async () => {
    fetchSpy.mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    await expect(service.list('c1', LOCAL)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });

  it('answers 502 for an error status or a body that is not a list', async () => {
    fetchSpy.mockResolvedValue(new Response('no', { status: 401 }));
    await expect(service.list('c1', LOCAL)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    fetchSpy.mockResolvedValue(new Response('{}'));
    await expect(service.list('c1', LOCAL)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
