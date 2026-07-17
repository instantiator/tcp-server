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

  it('returns server refresh_token from username+password grant', async () => {
    mockApiRequest.mockResolvedValue({
      access_token: 'server-token',
      refresh_token: 'server-refresh',
    });
    const session = await resolveSession({
      baseUrl: 'http://localhost:3000',
      username: 'alice',
      password: 'pass',
    });
    expect(session).toEqual({
      token: 'server-token',
      refreshToken: 'server-refresh',
    });
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

  it('exchanges username+password for a token via the API', async () => {
    mockApiRequest.mockResolvedValue({ access_token: 'server-token' });

    const token = await resolveToken({
      baseUrl: 'http://localhost:3000',
      username: 'alice',
      password: 'pass',
    });

    expect(token).toBe('server-token');
    expect(mockApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:3000' }),
      'POST',
      '/api/auth/token',
      { username: 'alice', password: 'pass' },
    );
  });
});
