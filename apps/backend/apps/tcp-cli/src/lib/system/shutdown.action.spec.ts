import { apiRequest } from '../core/api';
import { resolveSession, resolveToken, TokenManager } from '../auth/token';
import {
  cancelShutdownAction,
  restartAction,
  shutdownAction,
  ShutdownStatus,
} from './shutdown.action';

jest.mock('../auth/token');
jest.mock('../core/api');

const mockedResolveSession = resolveSession as jest.Mock;
const MockedTokenManager = TokenManager as jest.MockedClass<
  typeof TokenManager
>;

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };

function status(overrides: Partial<ShutdownStatus> = {}): ShutdownStatus {
  return {
    state: 'draining',
    forced: false,
    agentsRunning: 0,
    restart: false,
    restartSupported: false,
    ...overrides,
  };
}

describe('shutdownAction', () => {
  let request: jest.Mock;
  let stop: jest.Mock;
  let exitSpy: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Polling waits a second between reads; fake timers keep the specs instant.
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    request = jest.fn();
    stop = jest.fn();
    mockedResolveSession.mockResolvedValue({ token: 'token' });
    MockedTokenManager.mockImplementation(
      () => ({ request, stop }) as unknown as TokenManager,
    );
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
  });

  /** Runs the action, advancing fake timers so its polls resolve. */
  async function run(cmdOpts: Parameters<typeof shutdownAction>[1]) {
    const pending = shutdownAction(opts, cmdOpts);
    // Each pass of the poll loop awaits a timer; drain them until it settles.
    for (let tick = 0; tick < 20; tick++) {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
    }
    return pending;
  }

  it('drains gracefully, polling until quiesced', async () => {
    request
      .mockResolvedValueOnce(status({ agentsRunning: 2 }))
      .mockResolvedValueOnce(status({ agentsRunning: 1 }))
      .mockResolvedValue(status({ state: 'quiesced' }));

    await run({ timeout: 60 });

    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/api/system/shutdown');
    expect(request).toHaveBeenNthCalledWith(2, 'GET', '/api/system/shutdown');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join('')).toContain('safe to stop');
  });

  it('asks for the forced drain when --force is given', async () => {
    request.mockResolvedValue(status({ state: 'quiesced', forced: true }));

    await run({ force: true, timeout: 60 });

    expect(request).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/api/system/shutdown?force',
    );
  });

  it('reports what is still running and exits non-zero on timeout, without escalating to force', async () => {
    request.mockResolvedValue(status({ agentsRunning: 3 }));

    await run({ timeout: 2 });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = stderr.mock.calls.join('');
    expect(output).toContain('Timed out after 2s');
    expect(output).toContain('3 agent(s) still running');
    // Escalation is the operator's call — the drain must never upgrade itself.
    expect(request).not.toHaveBeenCalledWith(
      'POST',
      '/api/system/shutdown?force',
    );
  });

  it('says the containers were left alone when --no-stop is given', async () => {
    request.mockResolvedValue(status({ state: 'quiesced' }));

    await run({ noStop: true, timeout: 60 });

    expect(stderr.mock.calls.join('')).toContain('Containers left running');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('stops the background token refresh once it is done', async () => {
    request.mockResolvedValue(status({ state: 'quiesced' }));

    await run({ timeout: 60 });

    expect(stop).toHaveBeenCalled();
  });
});

describe('cancelShutdownAction', () => {
  it('sends DELETE and prints the returned status', async () => {
    mockedResolveToken.mockResolvedValue('token');
    mockedApiRequest.mockResolvedValue(status({ state: 'idle' }));
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    await cancelShutdownAction(opts);

    expect(mockedApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      'DELETE',
      '/api/system/shutdown',
    );
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify(status({ state: 'idle' }), null, 2) + '\n',
    );
  });
});

describe('restartAction', () => {
  let request: jest.Mock;
  let exitSpy: jest.SpyInstance;
  let stderr: jest.SpyInstance;
  let stdout: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers({ doNotFake: ['nextTick'] });
    request = jest.fn();
    mockedResolveSession.mockResolvedValue({ token: 'token' });
    MockedTokenManager.mockImplementation(
      () => ({ request, stop: jest.fn() }) as unknown as TokenManager,
    );
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.useRealTimers();
    exitSpy.mockRestore();
  });

  /** Runs the action, advancing fake timers so its polls resolve. */
  async function run(cmdOpts: Parameters<typeof restartAction>[1]) {
    const pending = restartAction(opts, cmdOpts);
    for (let tick = 0; tick < 20; tick++) {
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(1000);
    }
    return pending;
  }

  it('posts the restart request, and the forced one with --force', async () => {
    request.mockRejectedValue(new Error('down'));
    await run({ timeout: 2 });
    expect(request).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/api/system/shutdown?restart',
    );

    request.mockReset().mockRejectedValue(new Error('down'));
    await run({ force: true, timeout: 2 });
    expect(request).toHaveBeenNthCalledWith(
      1,
      'POST',
      '/api/system/shutdown?restart&force',
    );
  });

  it('waits through draining, quiesced and a failed read until idle', async () => {
    const idle = status({ state: 'idle', restart: true });
    request
      .mockResolvedValueOnce(status({ restart: true }))
      .mockResolvedValueOnce(status({ state: 'quiesced' }))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(idle);

    await run({ timeout: 60 });

    expect(exitSpy).not.toHaveBeenCalled();
    const output = stderr.mock.calls.join('');
    expect(output).toContain('Restart (graceful): draining');
    expect(output).toContain('Restarting the services…');
    expect(output).toContain('Restarted — the services are back');
    expect(stdout).toHaveBeenCalledWith(JSON.stringify(idle, null, 2) + '\n');
  });

  it('does not treat a read taken before the exit as the services being back', async () => {
    request
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(status({ state: 'quiesced' }))
      .mockResolvedValueOnce(status({ state: 'quiesced' }))
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValue(status({ state: 'idle' }));

    await run({ timeout: 60 });

    // POST, two quiesced reads, the failure, then the idle read that ends it.
    expect(request).toHaveBeenCalledTimes(5);
    expect(stderr.mock.calls.join('')).toContain('Restarted');
  });

  it('exits non-zero when the restart outlasts the timeout', async () => {
    request.mockResolvedValue(status({ state: 'quiesced' }));

    await run({ timeout: 3 });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderr.mock.calls.join('')).toContain(
      'Timed out after 3s waiting for the restart to finish.',
    );
    expect(stdout).toHaveBeenCalled();
  });
});
