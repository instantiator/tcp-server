import { resolveSession, TokenManager } from '../auth/token';
import { shutdownAction, ShutdownStatus } from './shutdown.action';

jest.mock('../auth/token');

const mockedResolveSession = resolveSession as jest.Mock;
const MockedTokenManager = TokenManager as jest.MockedClass<
  typeof TokenManager
>;

const opts = { tcpServer: 'http://localhost:3000' };

function status(overrides: Partial<ShutdownStatus> = {}): ShutdownStatus {
  return { state: 'draining', forced: false, agentsRunning: 0, ...overrides };
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
