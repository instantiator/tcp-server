import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { reindexKnowledgeAction } from './reindex-knowledge.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };

describe('reindexKnowledgeAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('triggers a reindex for a --company-id and prints the result', async () => {
    mockedApiRequest.mockResolvedValueOnce({ reindexing: true });

    await reindexKnowledgeAction(opts, { companyId: 'company-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/company/company-1/knowledge/reindex',
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ reindexing: true }, null, 2) + '\n',
    );
  });

  it('triggers a reindex for a --company-slug', async () => {
    mockedApiRequest.mockResolvedValueOnce({ reindexing: true });

    await reindexKnowledgeAction(opts, { companySlug: 'acme' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/company/acme/knowledge/reindex',
    );
  });

  it('triggers a reindex for the combined --company (slug or id)', async () => {
    mockedApiRequest.mockResolvedValueOnce({ reindexing: true });

    await reindexKnowledgeAction(opts, { company: 'acme' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      '/api/company/acme/knowledge/reindex',
    );
  });
});
