import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { eavesdropAction } from './eavesdrop.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };

/** Builds a fake fetch Response whose body streams the given SSE text in one chunk. */
function fakeSseResponse(sseText: string): Partial<Response> {
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({
            done: false,
            value: new TextEncoder().encode(sseText),
          });
        },
      }),
    } as unknown as ReadableStream<Uint8Array>,
  };
}

describe('eavesdropAction', () => {
  let exitSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('errors when no target is given', async () => {
    await eavesdropAction(opts, { showHistory: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors when more than one target is given', async () => {
    await eavesdropAction(opts, {
      agentId: 'a',
      taskId: 't',
      showHistory: true,
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('errors when neither --show-history nor --tail is given', async () => {
    await eavesdropAction(opts, { agentId: 'a' });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe('--show-history', () => {
    it('for --agent-id, fetches the agent then its history and prints formatted lines', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({ id: 'agent-1', status: 'running' }) // GET agent
        .mockResolvedValueOnce([
          {
            timestamp: '2026-01-01T10:00:00.000Z',
            eventType: 'state_change',
            payload: { newStatus: 'running', reason: 'started' },
          },
          {
            timestamp: '2026-01-01T10:00:05.000Z',
            eventType: 'agent_loop_completion',
            payload: { summary: 'Wrote the report' },
          },
        ]); // GET history

      const writes: string[] = [];
      (process.stdout.write as jest.Mock).mockImplementation((s: string) => {
        writes.push(s);
        return true;
      });

      await eavesdropAction(opts, { agentId: 'agent-1', showHistory: true });

      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'GET',
        '/api/agent/agent-1',
      );
      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'GET',
        '/api/agent/agent-1/history',
      );
      expect(writes.join('')).toContain('running (started)');
      expect(writes.join('')).toContain('Wrote the report');
    });

    it('for --assignment-id with no dispatched agent, prints nothing (no history call)', async () => {
      mockedApiRequest.mockResolvedValueOnce({
        id: 'assignment-1',
        agentId: null,
        status: 'ready',
      });

      await eavesdropAction(opts, {
        assignmentId: 'assignment-1',
        showHistory: true,
      });

      expect(mockedApiRequest).toHaveBeenCalledTimes(1); // no history fetch
    });
  });

  describe('--tail', () => {
    it('warns and exits when the target agent has already finished', async () => {
      mockedApiRequest.mockResolvedValueOnce({
        id: 'agent-1',
        status: 'completed',
      });

      await eavesdropAction(opts, { agentId: 'agent-1', tail: true });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('follows the SSE stream for a running agent until the completed event', async () => {
      mockedApiRequest.mockResolvedValueOnce({
        id: 'agent-1',
        status: 'running',
      });
      const sse =
        'data: {"kind":"response","data":{"delta":"Hello"},"timestamp":"t"}\n\n' +
        'data: {"kind":"completed","data":{"response":"Hello"},"timestamp":"t"}\n\n';
      fetchSpy.mockResolvedValue(fakeSseResponse(sse));

      await eavesdropAction(opts, { agentId: 'agent-1', tail: true });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent/agent-1/events',
        expect.objectContaining({
          headers: { Authorization: 'Bearer token' },
        }),
      );
    });
  });
});
