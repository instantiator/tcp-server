import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { getHealthAction, SystemHealth } from './health.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };
const health: SystemHealth = {
  status: 'degraded',
  services: [
    { name: 'tcp-server', status: 'up' },
    { name: 'tcp-agent', status: 'down', error: 'timeout' },
  ],
};

describe('getHealthAction', () => {
  let exitSpy: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    mockedApiRequest.mockResolvedValue(health);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  it('prints the whole result and exits cleanly even when degraded', async () => {
    await getHealthAction(opts, {});

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'GET',
      '/api/system/health',
    );
    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify(health, null, 2) + '\n',
    );
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints only the named service with --app', async () => {
    await getHealthAction(opts, { app: 'tcp-agent' });

    expect(process.stdout.write).toHaveBeenCalledWith(
      JSON.stringify(health.services[1], null, 2) + '\n',
    );
  });

  it('exits non-zero naming the known services for an unknown --app', async () => {
    await getHealthAction(opts, { app: 'nope' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.join('')).toContain(
      'No service named nope. Known: tcp-server, tcp-agent',
    );
  });
});
