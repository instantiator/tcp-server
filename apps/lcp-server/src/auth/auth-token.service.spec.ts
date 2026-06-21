import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthTokenService } from './auth-token.service';

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    OIDC_ISSUER_URL: 'http://keycloak/realms/lcp',
    OIDC_CLIENT_ID: 'lcp-server',
    OIDC_CLIENT_SECRET: 'secret',
    ...overrides,
  };
  return {
    get: (key: string) => defaults[key],
    getOrThrow: (key: string) => defaults[key],
  } as unknown as ConfigService;
}

describe('AuthTokenService', () => {
  let fetchSpy: jest.SpyInstance;
  let service: AuthTokenService;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
    service = new AuthTokenService(makeConfig());
  });

  afterEach(() => fetchSpy.mockRestore());

  it('fetches the discovery doc and exchanges credentials for a token', async () => {
    const discovery = {
      issuer: 'http://keycloak/realms/lcp',
      token_endpoint: 'http://keycloak/realms/lcp/protocol/token',
    };
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

    const result = await service.getToken('alice', 'pass');

    expect(result.access_token).toBe('abc');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      'http://keycloak/realms/lcp/.well-known/openid-configuration',
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      'http://keycloak/realms/lcp/protocol/token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('caches the discovery document on subsequent calls', async () => {
    const discovery = {
      issuer: 'http://keycloak/realms/lcp',
      token_endpoint: 'http://keycloak/realms/lcp/protocol/token',
    };
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
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(tokenResponse),
      });

    await service.getToken('alice', 'pass');
    await service.getToken('alice', 'pass');

    // Discovery endpoint called only once
    const calls = fetchSpy.mock.calls as [string, ...unknown[]][];
    const discoveryCalls = calls.filter((c) =>
      c[0].includes('openid-configuration'),
    );
    expect(discoveryCalls).toHaveLength(1);
  });

  it('throws UnauthorizedException when the OIDC token endpoint returns non-200', async () => {
    const discovery = {
      issuer: 'http://keycloak/realms/lcp',
      token_endpoint: 'http://keycloak/realms/lcp/protocol/token',
    };

    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(discovery),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 });

    await expect(service.getToken('alice', 'wrong')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  describe('refreshToken', () => {
    const discovery = {
      issuer: 'http://keycloak/realms/lcp',
      token_endpoint: 'http://keycloak/realms/lcp/protocol/token',
    };

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
