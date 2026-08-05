import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { validateSharedDocumentAction } from './validate-shared-document.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };

describe('validateSharedDocumentAction', () => {
  let exitSpy: jest.SpyInstance;
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('prints the results as JSON and exits 0 even when some validations fail', async () => {
    mockedApiRequest.mockResolvedValue({
      query: { path: 'acme/knowledge/*.md', recursive: false },
      validations: [
        {
          path: 'acme/knowledge/a.md',
          found: true,
          size: 1,
          valid: false,
          errors: ['bad'],
        },
      ],
    });
    await validateSharedDocumentAction(opts, { path: 'acme/knowledge/*.md' });
    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'http://localhost:3000' }),
      'POST',
      '/api/storage/validate',
      { path: 'acme/knowledge/*.md', recursive: false },
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('"valid": false'),
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('passes --recursive through', async () => {
    mockedApiRequest.mockResolvedValue({
      query: { path: 'acme/knowledge', recursive: true },
      validations: [],
    });
    await validateSharedDocumentAction(opts, {
      path: 'acme/knowledge',
      recursive: true,
    });
    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/storage/validate',
      { path: 'acme/knowledge', recursive: true },
    );
  });

  it('exits 1 with an error when the server returns a non-2xx response (e.g. 404)', async () => {
    mockedApiRequest.mockRejectedValue(
      new Error(
        'POST /api/storage/validate failed with HTTP 404: Not found: acme/missing.json',
      ),
    );
    await validateSharedDocumentAction(opts, { path: 'acme/missing.json' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Not found'),
    );
  });
});
