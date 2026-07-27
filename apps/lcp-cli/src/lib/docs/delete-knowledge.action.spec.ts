import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { deleteKnowledgeAction } from './delete-knowledge.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';

describe('deleteKnowledgeAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('deletes a document from a role scope and prints the deleted filename', async () => {
    mockedApiRequest.mockResolvedValueOnce(undefined);

    await deleteKnowledgeAction(opts, { roleId, file: 'report.md' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      `/api/role/${roleId}/knowledge/report.md`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ deleted: 'report.md' }, null, 2) + '\n',
    );
  });

  it('deletes a document from a company scope', async () => {
    mockedApiRequest.mockResolvedValueOnce(undefined);

    await deleteKnowledgeAction(opts, {
      companyId: 'company-1',
      file: 'policy.md',
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      '/api/company/company-1/knowledge/policy.md',
    );
  });
});
