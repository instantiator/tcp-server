import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { listTablesAction } from './list-tables.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = jest.mocked(apiRequest);
const mockedResolveToken = jest.mocked(resolveToken);

const opts = { tcpServer: 'http://localhost:3000' };

describe('listTablesAction', () => {
  let stdoutSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => stdoutSpy.mockRestore());

  it('requests the company tables and prints them as JSON', async () => {
    const tables = [
      { name: 'people', purpose: 'Staff', records: 3, updatedAt: 'x' },
    ];
    mockedApiRequest.mockResolvedValueOnce(tables);

    await listTablesAction(opts, { companyId: 'company-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/company/company-1/records/tables',
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(tables, null, 2) + '\n',
    );
  });
});
