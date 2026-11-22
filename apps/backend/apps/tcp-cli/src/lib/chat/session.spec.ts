import type { WireEvent } from '@tcp/shared';
import { apiRequest } from '../core/api';
import { ChatSession } from './session';

jest.mock('../core/api');

const mockedApiRequest = apiRequest as jest.Mock;

const opts = { tcpServer: 'http://localhost:3000' };

function makeSession() {
  return new ChatSession(opts, 'company-1', false, { token: 'token' });
}

describe('ChatSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  describe('startAgent / cleanup', () => {
    it('starts a chat agent for the role and deletes it on cleanup', async () => {
      const session = makeSession();
      mockedApiRequest.mockResolvedValueOnce({
        id: 'agent-1',
        status: 'idle',
        assignmentId: 'assignment-1',
      });

      const agentId = await session.startAgent('role-1');

      expect(agentId).toBe('agent-1');
      expect(mockedApiRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        '/api/agent/chat/start',
        { companyId: 'company-1', roleId: 'role-1' },
      );

      mockedApiRequest.mockResolvedValueOnce(undefined);
      await session.cleanup();

      expect(mockedApiRequest).toHaveBeenLastCalledWith(
        expect.anything(),
        'DELETE',
        '/api/agent/agent-1',
        undefined,
      );
    });
  });

  describe('runTurn', () => {
    /** Builds a fake `fetch` Response streaming the given wire events as SSE. */
    function sseResponse(events: WireEvent[]): Response {
      const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
      const bytes = new TextEncoder().encode(body);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
      return {
        ok: true,
        body: stream,
      } as unknown as Response;
    }

    /** The server's synthesized event for a late subscriber to an
     * already-idle agent — `runTurn` connects *before* posting the new
     * message, so the agent is always still idle from its previous turn (or
     * never having run) at that moment, making this the very first event on
     * every fresh connection, not a signal about the turn about to start. */
    const replayEvent: WireEvent = {
      type: 'audit',
      event: {
        timestamp: 't0',
        companyId: 'c',
        role: '',
        agentId: 'agent-1',
        assignmentId: null,
        taskId: null,
        eventType: 'state_change',
        payload: {
          entity: 'agent',
          newStatus: 'idle',
          response: '',
          reason: 'replay',
        },
      },
    };

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('ignores the replay-reason idle event instead of treating it as this turn already finished blank', async () => {
      const inputEvent: WireEvent = {
        type: 'audit',
        event: {
          timestamp: 't1',
          companyId: 'c',
          role: 'r',
          agentId: 'agent-1',
          assignmentId: null,
          taskId: null,
          eventType: 'input',
          payload: { text: 'hello' },
        },
      };
      const terminalEvent: WireEvent = {
        type: 'audit',
        event: {
          timestamp: 't2',
          companyId: 'c',
          role: 'r',
          agentId: 'agent-1',
          assignmentId: null,
          taskId: null,
          eventType: 'state_change',
          payload: {
            entity: 'agent',
            newStatus: 'idle',
            response: 'the real answer',
            reason: 'turn_complete',
          },
        },
      };
      jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          sseResponse([replayEvent, inputEvent, terminalEvent]),
        );
      mockedApiRequest.mockResolvedValueOnce({ accepted: true });
      const stdout = jest
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const session = makeSession();

      await session.runTurn('agent-1', 'hello', true);

      // The replay event must never surface as a premature empty completion;
      // the real terminal event's response is what gets printed.
      const written = stdout.mock.calls
        .map(([chunk]) => String(chunk))
        .join('');
      expect(written).toContain('the real answer');
      expect(written).not.toContain('(blank)');
    });
  });
});
