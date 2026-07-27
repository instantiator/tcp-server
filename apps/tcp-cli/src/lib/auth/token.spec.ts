import {
  resolveToken,
  resolveSession,
  renewToken,
  TokenManager,
} from './token';

// Mock the api module so we don't make real HTTP calls
jest.mock('../core/api', () => ({
  apiRequest: jest.fn(),
}));
import { apiRequest } from '../core/api';
const mockApiRequest = apiRequest as jest.Mock;

describe('resolveSession', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['TEST_TOKEN_VAR'];
  });

  it('returns explicit token without refreshToken when none provided', async () => {
    const session = await resolveSession({
      baseUrl: 'http://localhost:3000',
      accessToken: 'my-token',
    });
    expect(session).toEqual({ token: 'my-token', refreshToken: undefined });
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('threads refreshToken through when explicit access token is used', async () => {
    const session = await resolveSession({
      baseUrl: 'http://localhost:3000',
      accessToken: 'my-token',
      refreshToken: 'my-refresh',
    });
    expect(session).toEqual({ token: 'my-token', refreshToken: 'my-refresh' });
  });

  it('threads refreshToken through when env var token is used', async () => {
    process.env['TEST_TOKEN_VAR'] = 'env-token';
    const session = await resolveSession({
      baseUrl: 'http://localhost:3000',
      accessTokenEnvVar: 'TEST_TOKEN_VAR',
      refreshToken: 'my-refresh',
    });
    expect(session).toEqual({ token: 'env-token', refreshToken: 'my-refresh' });
  });

  describe('TCP_TOKEN fallback', () => {
    afterEach(() => delete process.env['TCP_TOKEN']);

    it('uses TCP_TOKEN when neither -t nor -E is given', async () => {
      process.env['TCP_TOKEN'] = 'fallback-token';
      const session = await resolveSession({
        baseUrl: 'http://localhost:3000',
      });
      expect(session).toEqual({
        token: 'fallback-token',
        refreshToken: undefined,
      });
      expect(mockApiRequest).not.toHaveBeenCalled();
    });

    it('prefers an explicit --access-token over TCP_TOKEN', async () => {
      process.env['TCP_TOKEN'] = 'fallback-token';
      const session = await resolveSession({
        baseUrl: 'http://localhost:3000',
        accessToken: 'explicit-token',
      });
      expect(session.token).toBe('explicit-token');
    });

    it('prefers an explicit --access-token-env-var over TCP_TOKEN', async () => {
      process.env['TCP_TOKEN'] = 'fallback-token';
      process.env['TEST_TOKEN_VAR'] = 'named-token';
      const session = await resolveSession({
        baseUrl: 'http://localhost:3000',
        accessTokenEnvVar: 'TEST_TOKEN_VAR',
      });
      expect(session.token).toBe('named-token');
    });

    it('does not use TCP_TOKEN as a silent substitute for an explicitly-named, unset env var', async () => {
      process.env['TCP_TOKEN'] = 'fallback-token';
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });
      await expect(
        resolveSession({
          baseUrl: 'http://localhost:3000',
          accessTokenEnvVar: 'UNSET_TOKEN_VAR',
        }),
      ).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('skips TCP_TOKEN and triggers device login when force is set', async () => {
      process.env['TCP_TOKEN'] = 'fallback-token';
      jest.useFakeTimers();
      mockApiRequest
        .mockResolvedValueOnce({
          device_code: 'dc-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'http://localhost:3000/device',
          expires_in: 300,
          interval: 5,
        })
        .mockResolvedValueOnce({
          access_token: 'fresh-token',
          refresh_token: 'fresh-refresh',
        });

      const promise = resolveSession({
        baseUrl: 'http://localhost:3000',
        force: true,
      });
      await jest.advanceTimersByTimeAsync(5_000);
      const session = await promise;

      expect(session).toEqual({
        token: 'fresh-token',
        refreshToken: 'fresh-refresh',
      });
      expect(mockApiRequest).toHaveBeenCalledWith(
        { baseUrl: 'http://localhost:3000' },
        'POST',
        '/api/auth/device',
      );
    });

    it('skips expired TCP_TOKEN and triggers device login', async () => {
      // Token expired 10 seconds ago
      const expired = Math.floor(Date.now() / 1000) - 10;
      const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
        'base64url',
      );
      const payload = Buffer.from(JSON.stringify({ exp: expired })).toString(
        'base64url',
      );
      process.env['TCP_TOKEN'] = `${header}.${payload}.sig`;

      jest.useFakeTimers();
      mockApiRequest
        .mockResolvedValueOnce({
          device_code: 'dc-1',
          user_code: 'ABCD-EFGH',
          verification_uri: 'http://localhost:3000/device',
          expires_in: 300,
          interval: 5,
        })
        .mockResolvedValueOnce({
          access_token: 'fresh-token',
        });

      const promise = resolveSession({
        baseUrl: 'http://localhost:3000',
      });
      await jest.advanceTimersByTimeAsync(5_000);
      const session = await promise;

      expect(session.token).toBe('fresh-token');
      expect(mockApiRequest).toHaveBeenCalledWith(
        { baseUrl: 'http://localhost:3000' },
        'POST',
        '/api/auth/device',
      );
    });
  });
});

describe('resolveSession — device login', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('polls until the device flow completes and returns the token', async () => {
    jest.useFakeTimers();
    mockApiRequest
      .mockResolvedValueOnce({
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://localhost:3000/device',
        expires_in: 300,
        interval: 5,
      })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({
        access_token: 'server-token',
        refresh_token: 'server-refresh',
      });

    const promise = resolveSession({ baseUrl: 'http://localhost:3000' });
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(5_000);
    const session = await promise;

    expect(session).toEqual({
      token: 'server-token',
      refreshToken: 'server-refresh',
    });
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      1,
      { baseUrl: 'http://localhost:3000' },
      'POST',
      '/api/auth/device',
    );
    expect(mockApiRequest).toHaveBeenNthCalledWith(
      3,
      { baseUrl: 'http://localhost:3000' },
      'POST',
      '/api/auth/device/token',
      { device_code: 'dc-1' },
    );
  });

  it('exits with an error when the device code expires before login completes', async () => {
    jest.useFakeTimers();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('exit');
    });
    mockApiRequest
      .mockResolvedValueOnce({
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://localhost:3000/device',
        expires_in: 5,
        interval: 5,
      })
      .mockResolvedValue({ status: 'pending' });

    const promise = resolveSession({ baseUrl: 'http://localhost:3000' }).catch(
      () => undefined,
    );
    await jest.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('renewToken', () => {
  afterEach(() => jest.clearAllMocks());

  it('calls /api/auth/refresh and returns the new access token', async () => {
    mockApiRequest.mockResolvedValue({ access_token: 'new-token' });

    const session = await renewToken('http://localhost:3000', 'old-refresh');

    expect(session).toEqual({
      token: 'new-token',
      refreshToken: 'old-refresh',
    });
    expect(mockApiRequest).toHaveBeenCalledWith(
      { baseUrl: 'http://localhost:3000' },
      'POST',
      '/api/auth/refresh',
      { refresh_token: 'old-refresh' },
    );
  });

  it('carries forward a rotated refresh token from the server', async () => {
    mockApiRequest.mockResolvedValue({
      access_token: 'new-token',
      refresh_token: 'rotated-refresh',
    });

    const session = await renewToken('http://localhost:3000', 'old-refresh');

    expect(session).toEqual({
      token: 'new-token',
      refreshToken: 'rotated-refresh',
    });
  });
});

/** Base64url-encodes a minimal JWT carrying only the given `exp` claim (seconds since epoch). */
function fakeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${header}.${payload}.`;
}

describe('TokenManager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('request', () => {
    it('makes an authenticated request with the current token', async () => {
      mockApiRequest.mockResolvedValueOnce({ ok: true });
      const manager = new TokenManager('http://localhost:3000', {
        token: 'my-token',
      });

      const result = await manager.request('GET', '/api/thing');

      expect(result).toEqual({ ok: true });
      expect(mockApiRequest).toHaveBeenCalledWith(
        {
          baseUrl: 'http://localhost:3000',
          token: 'my-token',
          signal: undefined,
        },
        'GET',
        '/api/thing',
        undefined,
      );
      manager.stop();
    });

    it('rethrows a non-401 error without retrying', async () => {
      mockApiRequest.mockRejectedValueOnce(new Error('HTTP 500'));
      const manager = new TokenManager('http://localhost:3000', {
        token: 'my-token',
        refreshToken: 'my-refresh',
      });

      await expect(manager.request('GET', '/api/thing')).rejects.toThrow(
        'HTTP 500',
      );
      expect(mockApiRequest).toHaveBeenCalledTimes(1);
      manager.stop();
    });

    it('rethrows a 401 when there is no refresh token to retry with', async () => {
      mockApiRequest.mockRejectedValueOnce(
        new Error('GET /x failed with HTTP 401'),
      );
      const manager = new TokenManager('http://localhost:3000', {
        token: 'my-token',
      });

      await expect(manager.request('GET', '/api/thing')).rejects.toThrow(
        'HTTP 401',
      );
      expect(mockApiRequest).toHaveBeenCalledTimes(1);
      manager.stop();
    });

    it('refreshes and retries once on a 401', async () => {
      mockApiRequest
        .mockRejectedValueOnce(new Error('GET /x failed with HTTP 401'))
        .mockResolvedValueOnce({ access_token: 'new-token' }) // /api/auth/refresh
        .mockResolvedValueOnce({ ok: true }); // retried request
      const manager = new TokenManager('http://localhost:3000', {
        token: 'old-token',
        refreshToken: 'my-refresh',
      });

      const result = await manager.request('GET', '/api/thing');

      expect(result).toEqual({ ok: true });
      expect(manager.current).toBe('new-token');
      expect(mockApiRequest).toHaveBeenNthCalledWith(
        3,
        {
          baseUrl: 'http://localhost:3000',
          token: 'new-token',
          signal: undefined,
        },
        'GET',
        '/api/thing',
        undefined,
      );
      manager.stop();
    });
  });

  describe('background refresh', () => {
    it("schedules a refresh shortly ahead of the token's exp claim", async () => {
      jest.useFakeTimers();
      const token = fakeJwt(Math.floor(Date.now() / 1000) + 60); // expires in 60s
      mockApiRequest.mockResolvedValueOnce({ access_token: 'refreshed' });
      const manager = new TokenManager('http://localhost:3000', {
        token,
        refreshToken: 'my-refresh',
      });

      // Refresh margin is 30s, so nothing should have fired yet at +29s.
      await jest.advanceTimersByTimeAsync(29_000);
      expect(mockApiRequest).not.toHaveBeenCalled();

      // ...but it should have by the time the margin is crossed.
      await jest.advanceTimersByTimeAsync(2_000);
      expect(mockApiRequest).toHaveBeenCalledWith(
        { baseUrl: 'http://localhost:3000' },
        'POST',
        '/api/auth/refresh',
        { refresh_token: 'my-refresh' },
      );
      expect(manager.current).toBe('refreshed');
      manager.stop();
    });

    it('never schedules a refresh without a refresh token', async () => {
      jest.useFakeTimers();
      const manager = new TokenManager('http://localhost:3000', {
        token: fakeJwt(Math.floor(Date.now() / 1000) + 60),
      });

      await jest.advanceTimersByTimeAsync(10 * 60_000);

      expect(mockApiRequest).not.toHaveBeenCalled();
      manager.stop();
    });
  });
});

describe('resolveToken', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env['TEST_TOKEN_VAR'];
  });

  it('returns the explicit access token immediately', async () => {
    const token = await resolveToken({
      baseUrl: 'http://localhost:3000',
      accessToken: 'my-token',
    });
    expect(token).toBe('my-token');
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('reads the token from an environment variable', async () => {
    process.env['TEST_TOKEN_VAR'] = 'env-token';
    const token = await resolveToken({
      baseUrl: 'http://localhost:3000',
      accessTokenEnvVar: 'TEST_TOKEN_VAR',
    });
    expect(token).toBe('env-token');
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('resolves via device login when no token is supplied', async () => {
    jest.useFakeTimers();
    mockApiRequest
      .mockResolvedValueOnce({
        device_code: 'dc-1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://localhost:3000/device',
        expires_in: 300,
        interval: 5,
      })
      .mockResolvedValueOnce({ access_token: 'server-token' });

    const promise = resolveToken({ baseUrl: 'http://localhost:3000' });
    await jest.advanceTimersByTimeAsync(5_000);
    const token = await promise;

    expect(token).toBe('server-token');
    jest.useRealTimers();
  });
});
