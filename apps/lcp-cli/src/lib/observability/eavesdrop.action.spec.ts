import { apiRequest } from '../core/api';
import { resolveToken } from '../auth/token';
import { eavesdropAction } from './eavesdrop.action';

jest.mock('../core/api');
jest.mock('../auth/token');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedResolveToken = resolveToken as jest.Mock;

const opts = { lcpServer: 'http://localhost:3000' };

const ROLE = { id: 'role-1', name: 'Implementer', slug: 'implementer' };

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

/** Builds a fake fetch Response whose body never yields any data (used for the task-events watch). */
function neverEndingSseResponse(): Partial<Response> {
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: () => new Promise(() => undefined),
      }),
    } as unknown as ReadableStream<Uint8Array>,
  };
}

describe('eavesdropAction', () => {
  let exitSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;
  let writes: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    mockedResolveToken.mockResolvedValue('token');
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writes = [];
    jest.spyOn(process.stdout, 'write').mockImplementation((s: string) => {
      writes.push(s);
      return true;
    });
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
    it('for --agent-id, fetches the agent, its role, then its history, and prints formatted lines', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          id: 'agent-1',
          status: 'running',
          roleId: 'role-1',
          assignmentId: 'assignment-1',
        }) // GET agent
        .mockResolvedValueOnce(ROLE) // GET role
        .mockResolvedValueOnce([
          {
            timestamp: '2026-01-01T10:00:00.000Z',
            eventType: 'state_change',
            agentId: 'agent-1',
            payload: { newStatus: 'running', reason: 'started' },
          },
          {
            timestamp: '2026-01-01T10:00:05.000Z',
            eventType: 'agent_loop_completion',
            agentId: 'agent-1',
            payload: { summary: 'Wrote the report' },
          },
        ]); // GET history

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
        '/api/role/role-1',
      );
      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        3,
        expect.anything(),
        'GET',
        '/api/agent/agent-1/history',
      );
      const text = writes.join('');
      expect(text).toContain('running (started)');
      // Fixed header label, not the payload's own leading line as the header.
      expect(text).toContain('assignment complete | Wrote the report');
      // The heading block, printed once for the one agent in this history.
      expect(text).toContain('Assignment id: assignment-1');
      expect(text).toContain('Agent role slug: implementer');
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

      expect(mockedApiRequest).toHaveBeenCalledTimes(1); // no role/history fetch
    });

    it('guards against an invalid/missing timestamp instead of printing "Invalid Date"', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          id: 'agent-1',
          status: 'completed',
          roleId: 'role-1',
          assignmentId: 'assignment-1',
        })
        .mockResolvedValueOnce(ROLE)
        .mockResolvedValueOnce([
          {
            timestamp: 'not-a-date',
            eventType: 'state_change',
            agentId: 'agent-1',
            payload: { newStatus: 'running' },
          },
        ]);

      await eavesdropAction(opts, { agentId: 'agent-1', showHistory: true });

      const text = writes.join('');
      expect(text).not.toContain('Invalid');
    });

    it('prints the heading block once per agent change across a task history, not per row', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          task: { id: 'task-1', companyId: 'company-1', status: 'in-progress' },
          assignments: [
            { id: 'assignment-1', agentId: 'agent-1', roleId: 'role-1' },
            { id: 'assignment-2', agentId: 'agent-2', roleId: 'role-1' },
          ],
        }) // GET task
        .mockResolvedValueOnce([ROLE]) // GET company roles
        .mockResolvedValueOnce([
          {
            timestamp: '2026-01-01T10:00:00.000Z',
            eventType: 'state_change',
            agentId: 'agent-1',
            payload: { newStatus: 'running' },
          },
          {
            timestamp: '2026-01-01T10:00:01.000Z',
            eventType: 'state_change',
            agentId: 'agent-1',
            payload: { newStatus: 'in-progress' },
          },
          {
            timestamp: '2026-01-01T10:00:02.000Z',
            eventType: 'state_change',
            agentId: 'agent-2',
            payload: { newStatus: 'running' },
          },
        ]); // GET task history

      await eavesdropAction(opts, { taskId: 'task-1', showHistory: true });

      const headingCount = writes.filter((w) =>
        w.startsWith('Assignment id: '),
      ).length;
      expect(headingCount).toBe(2); // once for agent-1, once for the switch to agent-2
    });
  });

  describe('--tail', () => {
    it('warns and exits when the target agent has already finished', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          id: 'agent-1',
          status: 'completed',
          roleId: 'role-1',
          assignmentId: 'assignment-1',
        })
        .mockResolvedValueOnce(ROLE);

      await eavesdropAction(opts, { agentId: 'agent-1', tail: true });

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('follows the SSE stream for a running agent until the completed event', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          id: 'agent-1',
          status: 'running',
          roleId: 'role-1',
          assignmentId: 'assignment-1',
        })
        .mockResolvedValueOnce(ROLE);
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
      // Short-id + role-slug prefix, not the full agent UUID.
      expect(writes.join('')).toContain('agent-1 (implementer)');
    });

    it('picks up a new assignment appearing on the task after an SSE assignment_changed event', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          task: { id: 'task-1', companyId: 'company-1', status: 'in-progress' },
          assignments: [
            { id: 'assignment-1', agentId: 'agent-1', roleId: 'role-1' },
          ],
        }) // GET task
        .mockResolvedValueOnce([ROLE]) // GET company roles
        // Follow-up fetch for the newly-appeared assignment
        .mockResolvedValueOnce({
          id: 'assignment-2',
          agentId: 'agent-2',
          roleId: 'role-1',
        })
        .mockResolvedValueOnce(ROLE);

      const agent2Sse =
        'data: {"kind":"completed","data":{"response":"done"},"timestamp":"t"}\n\n';
      const taskEventsSse =
        'data: {"kind":"assignment_changed","data":{"id":"assignment-2","status":"in-progress"},"timestamp":"t"}\n\n';

      fetchSpy.mockImplementation((url: string) => {
        if (url.endsWith('/api/agent/agent-2/events')) {
          return Promise.resolve(fakeSseResponse(agent2Sse));
        }
        if (url.endsWith('/api/task/task-1/events')) {
          return Promise.resolve(fakeSseResponse(taskEventsSse));
        }
        // agent-1's own stream never ends here — this test is only about the
        // task-events watch picking up assignment-2, not about either
        // follower's own completion.
        return Promise.resolve(neverEndingSseResponse());
      });

      // Deliberately not awaited: agent-1's follower never settles, so the
      // command itself never returns. Flush the microtask queue until
      // assignment-2's follow-up fetch/events chain has had a chance to run.
      void eavesdropAction(opts, { taskId: 'task-1', tail: true });
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent/agent-2/events',
        expect.anything(),
      );
    });
  });
});
