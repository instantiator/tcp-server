import { resolveToken, resolveSession, renewToken } from './auth';

// Mock the api module so we don't make real HTTP calls
jest.mock('./api', () => ({
  apiRequest: jest.fn(),
}));
import { apiRequest } from './api';
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

    const token = await renewToken('http://localhost:3000', 'old-refresh');

    expect(token).toBe('new-token');
    expect(mockApiRequest).toHaveBeenCalledWith(
      { baseUrl: 'http://localhost:3000' },
      'POST',
      '/api/auth/refresh',
      { refresh_token: 'old-refresh' },
    );
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
