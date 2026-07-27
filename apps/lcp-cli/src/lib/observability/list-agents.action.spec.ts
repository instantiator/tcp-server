import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { listAgentsAction } from './list-agents.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };

describe('listAgentsAction', () => {
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

  it('lists agents for a --company-id', async () => {
    mockedApiRequest.mockResolvedValueOnce([{ id: 'agent-1' }]);

    await listAgentsAction(opts, { companyId: 'company-1' });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/agent?companyId=company-1',
    );
  });

  it('lists agents for a combined --role, sending roleId', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAgentsAction(opts, { role: uuid });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      `/api/agent?roleId=${uuid}`,
    );
  });

  it('applies --filter status=', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAgentsAction(opts, {
      companyId: 'company-1',
      filter: ['status=paused'],
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/agent?companyId=company-1&status=paused',
    );
  });

  it('applies --filter assignment=', async () => {
    mockedApiRequest.mockResolvedValueOnce([]);

    await listAgentsAction(opts, {
      companyId: 'company-1',
      filter: ['assignment=assignment-1'],
    });

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/agent?companyId=company-1&assignmentId=assignment-1',
    );
  });

  it('errors when neither a role/company nor --filter assignment= is given', async () => {
    await listAgentsAction(opts, {});
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockedApiRequest).not.toHaveBeenCalled();
  });
});
