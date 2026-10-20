import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { updateMemoryAction } from './update-memory.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';
const memory = { id: 'mem-1', content: 'x', tags: [] };

describe('updateMemoryAction', () => {
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

  it('PATCHes only the content when only content is given', async () => {
    mockedApiRequest.mockResolvedValueOnce(memory);

    await updateMemoryAction(opts, { roleId, id: 'mem-1', content: 'y' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'PATCH',
      `/api/role/${roleId}/memory/mem-1`,
      { content: 'y' },
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(memory, null, 2) + '\n',
    );
  });

  it('PATCHes only the tags when only tags are given', async () => {
    mockedApiRequest.mockResolvedValueOnce(memory);

    await updateMemoryAction(opts, { roleId, id: 'mem-1', tags: 'a, b' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'PATCH',
      `/api/role/${roleId}/memory/mem-1`,
      { tags: ['a', 'b'] },
    );
  });

  it('reports an error and makes no request when nothing is given', async () => {
    await updateMemoryAction(opts, { roleId, id: 'mem-1' });

    expect(mockedApiRequest).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('Provide --content, --tags, or both'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
