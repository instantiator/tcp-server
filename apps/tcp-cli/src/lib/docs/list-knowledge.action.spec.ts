import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { listKnowledgeAction } from './list-knowledge.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';

describe('listKnowledgeAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('lists documents for a --role-id scope', async () => {
    mockedApiRequest.mockResolvedValueOnce([
      { key: 'x', name: 'report.md', size: 10, lastModified: 'x' },
    ]);

    await listKnowledgeAction(opts, { roleId });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/role/${roleId}/knowledge`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      expect.stringContaining('report.md'),
    );
  });

  it('lists documents for a --company-id scope', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listKnowledgeAction(opts, { companyId: 'company-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/company/company-1/knowledge',
    );
  });

  it('prints an empty array when the scope has no documents', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listKnowledgeAction(opts, { roleId });

    expect(stdoutSpy).toHaveBeenCalledWith('[]\n');
  });
});
