import { apiDownload, apiRequest, apiUpload } from './api';

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

  it('prints X-Tcp-Warnings to stderr in yellow with a warning emoji', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-Tcp-Warnings': JSON.stringify([
          'Role has a blank or missing rolePrompt.',
        ]),
      }),
      json: () => Promise.resolve({ id: '1' }),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000' },
      'POST',
      '/api/role',
      {},
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Role has a blank or missing rolePrompt.'),
    );
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️'));
    stderrSpy.mockRestore();
  });

  it('decodes a percent-encoded X-Tcp-Warnings entry before printing (matches setWarningsHeader server-side)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    const message = 'Last reindex failed: connect refused — 例え話';
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-Tcp-Warnings': JSON.stringify([encodeURIComponent(message)]),
      }),
      json: () => Promise.resolve({ id: '1' }),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000' },
      'GET',
      '/api/role/1/knowledge/status',
    );

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(message));
    stderrSpy.mockRestore();
  });

  it('falls back to the raw entry when it is not validly percent-encoded, rather than dropping it', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-Tcp-Warnings': JSON.stringify(['not%valid%encoding']),
      }),
      json: () => Promise.resolve({ id: '1' }),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000' },
      'GET',
      '/api/role/1/knowledge/status',
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('not%valid%encoding'),
    );
    stderrSpy.mockRestore();
  });

  it('does not write to stderr when there are no warnings', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ id: '1' }),
    });

    await apiRequest(
      { baseUrl: 'http://localhost:3000' },
      'GET',
      '/api/role/1',
    );

    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
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

describe('apiUpload', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('returns the parsed response on success', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ key: 'a/knowledge/b/c.md' }),
    });

    const result = await apiUpload(
      { baseUrl: 'http://localhost:3000', token: 'tok' },
      '/api/role/1/knowledge',
      'notes.md',
      Buffer.from('content'),
    );

    expect(result).toEqual({ key: 'a/knowledge/b/c.md' });
  });

  it('appends errors[].llmHint to the thrown message, so a validation-failure template reaches the user', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 422,
      json: () =>
        Promise.resolve({
          message: 'Document failed validation',
          errors: [
            {
              message: 'Missing or unparsable YAML front-matter',
              llmHint:
                "OKF documents require YAML front-matter with at least a 'title' field, e.g.:\n---\ntitle: My Document\n---",
            },
          ],
        }),
    });

    await expect(
      apiUpload(
        { baseUrl: 'http://localhost:3000' },
        '/api/role/1/knowledge',
        'bad.md',
        Buffer.from('# no front-matter'),
      ),
    ).rejects.toThrow(
      "HTTP 422: Document failed validation\nOKF documents require YAML front-matter with at least a 'title' field, e.g.:\n---\ntitle: My Document\n---",
    );
  });

  it('falls back to just the message when there are no errors[].llmHint entries', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ message: 'Bad request' }),
    });

    await expect(
      apiUpload(
        { baseUrl: 'http://localhost:3000' },
        '/api/role/1/knowledge',
        'archive.zip',
        Buffer.from(''),
      ),
    ).rejects.toThrow('HTTP 400: Bad request');
  });

  it('prints X-Tcp-Warnings on a successful upload', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({
        'X-Tcp-Warnings': JSON.stringify([
          'No embedding config resolved for this company.',
        ]),
      }),
      json: () => Promise.resolve({ key: 'a/knowledge/b/c.md' }),
    });

    await apiUpload(
      { baseUrl: 'http://localhost:3000' },
      '/api/role/1/knowledge',
      'notes.md',
      Buffer.from('content'),
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No embedding config resolved for this company.'),
    );
    stderrSpy.mockRestore();
  });
});

describe('apiDownload', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => fetchSpy.mockRestore());

  it('returns the file data, content type, and filename from Content-Disposition', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'content-type': 'text/markdown',
        'content-disposition': 'attachment; filename="report.md"',
      }),
      arrayBuffer: () =>
        Promise.resolve(new TextEncoder().encode('content').buffer),
    });

    const result = await apiDownload(
      { baseUrl: 'http://localhost:3000' },
      '/api/role/1/knowledge/report.md',
    );

    expect(result.data.toString('utf-8')).toBe('content');
    expect(result.contentType).toBe('text/markdown');
    expect(result.filename).toBe('report.md');
  });

  it('throws an Error on non-OK responses', async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ message: 'Not found' }),
    });

    await expect(
      apiDownload(
        { baseUrl: 'http://localhost:3000' },
        '/api/role/1/knowledge/missing.md',
      ),
    ).rejects.toThrow('HTTP 404');
  });

  it('prints X-Tcp-Warnings on a successful download', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        'X-Tcp-Warnings': JSON.stringify([
          'No embedding config resolved for this company.',
        ]),
      }),
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await apiDownload(
      { baseUrl: 'http://localhost:3000' },
      '/api/role/1/knowledge/report.md',
    );

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('No embedding config resolved for this company.'),
    );
    stderrSpy.mockRestore();
  });
});
