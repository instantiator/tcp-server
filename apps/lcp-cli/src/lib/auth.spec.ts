import { resolveToken } from './auth';

// Mock the api module so we don't make real HTTP calls
jest.mock('./api', () => ({
  apiRequest: jest.fn(),
}));
import { apiRequest } from './api';
const mockApiRequest = apiRequest as jest.Mock;

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
