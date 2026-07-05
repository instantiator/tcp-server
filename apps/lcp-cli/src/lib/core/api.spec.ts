import { apiRequest } from './api';

describe('apiRequest', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('calls fetch with the correct URL, method, and Authorization header', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: '1' }),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000', token: 'tok' },
      'GET',
      '/api/company',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/company',
      expect.objectContaining({
        method: 'GET',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
  });

  it('sends the body as JSON for POST requests', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000' },
      'POST',
      '/api/auth/token',
      {
        username: 'alice',
        password: 'pass',
      },
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ username: 'alice', password: 'pass' }),
      }),
    );
  });

  it('returns undefined for 204 No Content', async () => {
    fetchSpy.mockResolvedValue({ ok: true, status: 204 });

    const result = await apiRequest(
      { baseUrl: 'http://localhost:3000' },
      'DELETE',
      '/api/agent/1',
    );
    expect(result).toBeUndefined();
  });

  it('throws an Error on non-OK responses', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ message: 'Not found' }),
    });

    await expect(
      apiRequest(
        { baseUrl: 'http://localhost:3000' },
        'GET',
        '/api/company/bad-id',
      ),
    ).rejects.toThrow('HTTP 404');
  });

  it('strips trailing slash from baseUrl', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000/' },
      'GET',
      '/api/company',
    );

    const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe('http://localhost:3000/api/company');
  });
});
