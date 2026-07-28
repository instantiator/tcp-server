import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { InternalApiClient } from './internal-api.client';

jest.mock('axios');

const BASE_URL = 'http://tcp-server:3000';
const AUTH = { headers: { 'X-Internal-Api-Key': 'key' } };

function makeClient(): InternalApiClient {
  const config = {
    getOrThrow: jest
      .fn()
      .mockImplementation((key: string) =>
        key === 'TCP_SERVER_URL' ? BASE_URL : 'key',
      ),
  } as unknown as ConfigService;
  return new InternalApiClient(config);
}

/** Lets a pending fire-and-forget rejection reach its catch handler. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('InternalApiClient', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => jest.clearAllMocks());

  describe('get', () => {
    it('resolves the path against the server URL, authenticates, and unwraps data', async () => {
      jest.spyOn(axios, 'get').mockResolvedValue({ data: { ok: true } });

      await expect(makeClient().get('/internal/thing')).resolves.toEqual({
        ok: true,
      });
      expect(axios.get).toHaveBeenCalledWith(
        `${BASE_URL}/internal/thing`,
        AUTH,
      );
    });

    it('propagates errors so callers can relay a corrective 4xx', async () => {
      jest.spyOn(axios, 'get').mockRejectedValue(new Error('boom'));
      await expect(makeClient().get('/internal/thing')).rejects.toThrow('boom');
    });
  });

  describe('post', () => {
    it('sends the body with auth headers and unwraps data', async () => {
      jest.spyOn(axios, 'post').mockResolvedValue({ data: { created: 2 } });

      await expect(
        makeClient().post('/internal/thing', { a: 1 }),
      ).resolves.toEqual({ created: 2 });
      expect(axios.post).toHaveBeenCalledWith(
        `${BASE_URL}/internal/thing`,
        { a: 1 },
        AUTH,
      );
    });

    it('propagates errors', async () => {
      jest.spyOn(axios, 'post').mockRejectedValue(new Error('boom'));
      await expect(makeClient().post('/internal/thing', {})).rejects.toThrow(
        'boom',
      );
    });
  });

  // The fire-and-forget variants exist so audit and tracking writes can never
  // interrupt an agent run — a failure must log and stop there.
  describe.each([
    ['postAndForget', 'post'],
    ['patchAndForget', 'patch'],
  ] as const)('%s', (method, verb) => {
    it('sends the request with auth headers', () => {
      jest.spyOn(axios, verb).mockResolvedValue({ status: 204 });

      makeClient()[method]('/internal/thing', { a: 1 }, 'Thing write');

      expect(axios[verb]).toHaveBeenCalledWith(
        `${BASE_URL}/internal/thing`,
        { a: 1 },
        AUTH,
      );
    });

    it('swallows the failure and logs it against the context', async () => {
      jest.spyOn(axios, verb).mockRejectedValue(new Error('network error'));

      expect(() =>
        makeClient()[method]('/internal/thing', {}, 'Thing write'),
      ).not.toThrow();
      await flush();

      expect(warnSpy).toHaveBeenCalledWith('Thing write failed: network error');
    });

    it('logs a non-Error rejection too', async () => {
      jest.spyOn(axios, verb).mockRejectedValue('just a string');

      makeClient()[method]('/internal/thing', {}, 'Thing write');
      await flush();

      expect(warnSpy).toHaveBeenCalledWith('Thing write failed: just a string');
    });
  });
});
