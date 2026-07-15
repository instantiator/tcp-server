import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { listAssignmentsAction } from './list-assignments.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };

describe('listAssignmentsAction', () => {
  let exitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => exitSpy.mockRestore());

  it('lists assignments for a --task-id', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAssignmentsAction(opts, { taskId: 'task-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/assignment?taskId=task-1',
    );
  });

  it('lists assignments for a company', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAssignmentsAction(opts, { companyId: 'company-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/assignment?companyId=company-1',
    );
  });

  it('--filter task= overrides --task-id', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAssignmentsAction(opts, {
      taskId: 'task-1',
      filter: ['task=task-2'],
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/assignment?taskId=task-2',
    );
  });

  it('--filter task=null lists orphan assignments', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAssignmentsAction(opts, {
      companyId: 'company-1',
      filter: ['task=null'],
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/assignment?companyId=company-1&taskId=null',
    );
  });

  it('applies --filter status=', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAssignmentsAction(opts, {
      taskId: 'task-1',
      filter: ['status=in-progress'],
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/assignment?taskId=task-1&status=in-progress',
    );
  });

  it('errors when neither --task-id, a company, nor --filter task= is given', async () => {
    await listAssignmentsAction(opts, {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });
});
