import * as fs from 'fs';
import { apiRequest, apiUpload } from '../core/api';
import { resolveToken } from '../auth/token';
import {
  cancelTaskAction,
  createTaskAction,
  getTaskAction,
  listTasksAction,
} from './task.action';

jest.mock('../core/api');
jest.mock('../auth/token');
jest.mock('fs');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedApiUpload = apiUpload as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;
const mockedFs = fs as jest.Mocked<typeof fs>;

const opts = { lcpServer: 'http://localhost:3000' };
const company = { id: 'company-id' };
const task = { id: 'task-id', status: 'ready' };

describe('createTaskAction', () => {
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

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('creates a task from --company and --request', async () => {
    mockedApiRequest.mockResolvedValueOnce(company); // GET company
    mockedApiRequest.mockResolvedValueOnce(task); // POST task

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
    });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'POST',
      '/api/task',
      { companyId: company.id, request: 'Write a report' },
    );
  });

  it('resolves a UUID plannerRole directly without an extra lookup', async () => {
    const plannerRoleId = '11111111-1111-1111-1111-111111111111';
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce(task);

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
      plannerRole: plannerRoleId,
    });

    expect(mockedApiRequest).toHaveBeenCalledTimes(2); // no role lookup call
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'POST',
      '/api/task',
      { companyId: company.id, request: 'Write a report', plannerRoleId },
    );
  });

  it('resolves a slug plannerRole via the company-scoped by-slug lookup', async () => {
    mockedApiRequest.mockResolvedValueOnce(company); // GET company
    mockedApiRequest.mockResolvedValueOnce({ id: 'role-id' }); // GET role by slug
    mockedApiRequest.mockResolvedValueOnce(task); // POST task

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
      plannerRole: 'planner',
    });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'GET',
      `/api/company/${company.id}/roles/by-slug/planner`,
    );
    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'POST',
      '/api/task',
      {
        companyId: company.id,
        request: 'Write a report',
        plannerRoleId: 'role-id',
      },
    );
  });

  it('maps --expected filenames to task-completed-path artifacts', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce(task);

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
      expected: ['report.md'],
    });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'POST',
      '/api/task',
      {
        companyId: company.id,
        request: 'Write a report',
        expected: [{ type: 'task-completed-path', value: 'report.md' }],
      },
    );
  });

  it('uploads each material file after creation', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce(task);
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(Buffer.from('hello'));
    mockedApiUpload.mockResolvedValue({ key: 'k', name: 'brief.txt', size: 5 });

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
      materials: ['./brief.txt'],
    });

    expect(mockedApiUpload).toHaveBeenCalledWith(
      expect.anything(),
      `/api/task/${task.id}/materials`,
      'brief.txt',
      Buffer.from('hello'),
    );
  });

  it('exits with an error when a material file does not exist', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce(task);
    mockedFs.existsSync.mockReturnValue(false);

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
      materials: ['./missing.txt'],
    });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedApiUpload).not.toHaveBeenCalled();
  });

  it('starts the task when --start is given', async () => {
    const started = { ...task, status: 'planning' };
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce(task);
    mockedApiRequest.mockResolvedValueOnce(started);

    await createTaskAction(opts, {
      company: 'acme',
      request: 'Write a report',
      start: true,
    });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      'POST',
      `/api/task/${task.id}/start`,
    );
  });
});

describe('listTasksAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('resolves the company then lists its tasks', async () => {
    mockedApiRequest.mockResolvedValueOnce(company);
    mockedApiRequest.mockResolvedValueOnce([task]);

    await listTasksAction(opts, { company: 'acme' });

    expect(mockedApiRequest).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'GET',
      `/api/task?companyId=${company.id}`,
    );
  });
});

describe('getTaskAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('fetches the task by id', async () => {
    mockedApiRequest.mockResolvedValueOnce({ task, assignments: [] });

    await getTaskAction(opts, { taskId: task.id });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/task/${task.id}`,
    );
  });
});

describe('cancelTaskAction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('cancels the task by id', async () => {
    const cancelled = { ...task, status: 'cancelled' };
    mockedApiRequest.mockResolvedValueOnce(cancelled);

    await cancelTaskAction(opts, { taskId: task.id });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'POST',
      `/api/task/${task.id}/cancel`,
    );
  });
});
