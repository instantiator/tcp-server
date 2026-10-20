import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { listMemoriesAction } from './list-memories.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';
const memory = { id: 'mem-1', content: 'x', tags: [] };

describe('listMemoriesAction', () => {
  let stdoutSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    stdoutSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('GETs the role memories and prints the JSON', async () => {
    const result = { memories: [memory], truncated: false, canWrite: true };
    mockedApiRequest.mockResolvedValueOnce(result);

    await listMemoriesAction(opts, { roleId });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/role/${roleId}/memory`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(result, null, 2) + '\n',
    );
  });
});
