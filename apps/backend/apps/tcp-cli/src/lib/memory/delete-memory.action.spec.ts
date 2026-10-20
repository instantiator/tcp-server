import { apiRequest } from '../core/api';
import { confirmAction } from '../core/confirm';
import { resolveToken } from '../auth/token';
import { deleteMemoryAction } from './delete-memory.action';

jest.mock('../core/api');
jest.mock('../core/confirm');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedConfirm = confirmAction as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const roleId = '11111111-2222-3333-4444-555555555555';

describe('deleteMemoryAction', () => {
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

  it('deletes without asking when --force is given', async () => {
    mockedApiRequest.mockResolvedValueOnce(undefined);

    await deleteMemoryAction(opts, { roleId, id: 'mem-1', force: true });

    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      `/api/role/${roleId}/memory/mem-1`,
    );
    expect(stdoutSpy).toHaveBeenCalledWith('Deleted memory mem-1\n');
  });

  it('asks first and deletes when confirmed', async () => {
    mockedConfirm.mockResolvedValueOnce(true);
    mockedApiRequest.mockResolvedValueOnce(undefined);

    await deleteMemoryAction(opts, { roleId, id: 'mem-1' });

    expect(mockedConfirm).toHaveBeenCalledWith('Delete memory mem-1?');
    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      `/api/role/${roleId}/memory/mem-1`,
    );
  });

  it('makes no request when the confirmation is declined', async () => {
    mockedConfirm.mockResolvedValueOnce(false);

    await deleteMemoryAction(opts, { roleId, id: 'mem-1' });

    expect(mockedApiRequest).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith('Aborted.\n');
  });
});
