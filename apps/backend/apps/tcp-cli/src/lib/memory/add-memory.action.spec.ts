import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { addMemoryAction } from './add-memory.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';
const memory = { id: 'mem-1', content: 'x', tags: [] };

describe('addMemoryAction', () => {
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

  it('POSTs trimmed tags with empties dropped and prints the memory', async () => {
    mockedApiRequest.mockResolvedValueOnce(memory);

    await addMemoryAction(opts, { roleId, content: 'x', tags: ' a, b ,' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      `/api/role/${roleId}/memory`,
      { content: 'x', tags: ['a', 'b'] },
    );
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify(memory, null, 2) + '\n',
    );
  });

  it('leaves tags out of the body when none are given', async () => {
    mockedApiRequest.mockResolvedValueOnce(memory);

    await addMemoryAction(opts, { roleId, content: 'x' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      `/api/role/${roleId}/memory`,
      { content: 'x' },
    );
  });
});
