import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthTokenService } from './auth-token.service';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    OIDC_ISSUER_URL: 'http://localhost:8080',
    OIDC_INTERNAL_ISSUER_URL: 'http://zitadel:8080',
    OIDC_CLIENT_ID: 'tcp-server',
    OIDC_CLIENT_SECRET: 'secret',
    ...overrides,
  };
  return {
    get: (key: string) => defaults[key],
    getOrThrow: (key: string) => defaults[key],
  } as unknown as ConfigService;
}

const discovery = {
  issuer: 'http://localhost:8080',
  token_endpoint: 'http://localhost:8080/oauth/v2/token',
  device_authorization_endpoint:
    'http://localhost:8080/oauth/v2/device_authorization',
};

describe('AuthTokenService', () => {
  let fetchSpy: jest.SpyInstance;
  let service: AuthTokenService;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    service = new AuthTokenService(makeConfig());
  });

  afterEach(() => fetchSpy.mockRestore());

  describe('startDeviceAuthorization', () => {
    it('fetches the discovery doc and starts a device authorization', async () => {
      const deviceResponse = {
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://localhost:8080/device',
        expires_in: 300,
        interval: 5,
      };

      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(discovery),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(deviceResponse),
        });

      const result = await service.startDeviceAuthorization();

      expect(result.user_code).toBe('ABCD-EFGH');
      expect(fetchSpy).toHaveBeenNthCalledWith(
        1,
        'http://zitadel:8080/.well-known/openid-configuration',
        expect.objectContaining({
          headers: { 'X-Forwarded-Host': 'localhost:8080' },
        }),
      );
      expect(fetchSpy).toHaveBeenNthCalledWith(
        2,
        // Rebased onto the internal issuer so the request stays on the internal network.
        'http://zitadel:8080/oauth/v2/device_authorization',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Forwarded-Host': 'localhost:8080',
          },
        }),
      );
    });

    it('throws when the provider does not advertise device authorization support', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            issuer: 'http://localhost:8080',
            token_endpoint: 'http://localhost:8080/oauth/v2/token',
          }),
      });

      await expect(service.startDeviceAuthorization()).rejects.toThrow(
        /device_authorization_endpoint/,
      );
    });
  });

  describe('pollDeviceToken', () => {
    it('returns pending while the human has not completed login', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(discovery),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'authorization_pending' }),
        });

      const result = await service.pollDeviceToken('dc-1');
      expect(result).toEqual({ status: 'pending' });
    });

    it('returns the token once the human completes login', async () => {
      const tokenResponse = {
        access_token: 'abc',
        token_type: 'Bearer',
        expires_in: 300,
      };
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(discovery),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });

      const result = await service.pollDeviceToken('dc-1');
      expect(result).toEqual({ status: 'complete', ...tokenResponse });
    });

    it('throws UnauthorizedException on a terminal error', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(discovery),
        })
        .mockResolvedValueOnce({
          ok: false,
          json: () => Promise.resolve({ error: 'expired_token' }),
        });

      await expect(service.pollDeviceToken('dc-1')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });

  it('caches the discovery document across calls', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(discovery),
      })
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ error: 'authorization_pending' }),
      });

    await service.pollDeviceToken('dc-1');
    await service.pollDeviceToken('dc-1');

    const calls = fetchSpy.mock.calls as [string, ...unknown[]][];
    const discoveryCalls = calls.filter((c) =>
      c[0].includes('openid-configuration'),
    );
    expect(discoveryCalls).toHaveLength(1);
  });

  describe('refreshToken', () => {
    it('exchanges a refresh token for a new access token', async () => {
      const tokenResponse = {
        access_token: 'new-token',
        token_type: 'Bearer',
        expires_in: 300,
        refresh_token: 'new-refresh',
      };

      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(discovery),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(tokenResponse),
        });

      const result = await service.refreshToken('old-refresh');

      expect(result.access_token).toBe('new-token');
      const body = new URLSearchParams(
        (fetchSpy.mock.calls[1] as [string, { body: string }])[1].body,
      );
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('old-refresh');
    });

    it('throws UnauthorizedException when refresh token is invalid', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(discovery),
        })
        .mockResolvedValueOnce({ ok: false, status: 401 });

      await expect(service.refreshToken('expired-refresh')).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
