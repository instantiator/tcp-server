import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { getKnowledgeIndexStatusAction } from './get-knowledge-index-status.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';

describe('getKnowledgeIndexStatusAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('reports status for a --role-id scope', async () => {
    const status = {
      documentCount: 2,
      totalBytes: 200,
      chunkCount: 7,
      generation: 3,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      indexing: false,
    };
    mockedApiRequest.mockResolvedValueOnce(status);

    await getKnowledgeIndexStatusAction(opts, { roleId });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/role/${roleId}/knowledge/status`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(status, null, 2) + '\n',
    );
  });

  it('reports status for a --company-id scope (shared + roles)', async () => {
    const status = {
      shared: {
        documentCount: 0,
        totalBytes: 0,
        chunkCount: 0,
        generation: 0,
        lastIndexedAt: null,
        indexing: false,
      },
      roles: [],
    };
    mockedApiRequest.mockResolvedValueOnce(status);

    await getKnowledgeIndexStatusAction(opts, { companyId: 'company-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/company/company-1/knowledge/status',
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(status, null, 2) + '\n',
    );
  });
});
