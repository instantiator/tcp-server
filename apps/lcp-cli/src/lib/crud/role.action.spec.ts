import { apiRequest } from '../core/api';
import { confirmAction } from '../core/confirm';
import { resolveToken } from '../auth/token';
import { deleteRoleAction } from './role.action';

jest.mock('../core/api');
jest.mock('../core/confirm');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedConfirm = confirmAction as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };
const role = { id: 'role-id', slug: 'analyst', name: 'Analyst' };

describe('deleteRoleAction', () => {
  let exitSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('deletes without prompting when --force is given', async () => {
    mockedApiRequest.mockResolvedValueOnce(role); // GET
    mockedApiRequest.mockResolvedValueOnce(undefined); // DELETE

    await deleteRoleAction(opts, { roleId: role.id, force: true });

    expect(mockedConfirm).not.toHaveBeenCalled();
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'DELETE',
      `/api/role/${role.id}`,
    );
  });

  it('prompts for confirmation and deletes when confirmed', async () => {
    mockedApiRequest.mockResolvedValueOnce(role);
    mockedApiRequest.mockResolvedValueOnce(undefined);
    mockedConfirm.mockResolvedValue(true);

    await deleteRoleAction(opts, { roleId: role.id });

    expect(mockedConfirm).toHaveBeenCalledTimes(1);
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'DELETE',
      `/api/role/${role.id}`,
    );
  });

  it('aborts without deleting when the user declines', async () => {
    mockedApiRequest.mockResolvedValueOnce(role);
    mockedConfirm.mockResolvedValue(false);

    await deleteRoleAction(opts, { roleId: role.id });

    expect(mockedApiRequest).toHaveBeenCalledTimes(1); // GET only, no DELETE
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Aborted'));
  });

  it('errors when --role-slug is given without a company identifier', async () => {
    await deleteRoleAction(opts, { roleSlug: 'analyst' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
