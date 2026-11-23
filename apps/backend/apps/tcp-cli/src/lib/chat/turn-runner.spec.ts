import type { AuditEventType, WireEvent } from '@tcp/shared';
import { apiRequest } from '../core/api';
import { ChatSession } from './session';

jest.mock('../core/api');

const mockedApiRequest = apiRequest as jest.Mock;

/** An audit WireEvent for `agentId` with the given type and payload. */
function audit(
  agentId: string,
  eventType: AuditEventType,
  payload: Record<string, unknown>,
): WireEvent {
  return {
    type: 'audit',
    event: {
      timestamp: 't',
      companyId: 'c',
      role: 'r',
      agentId,
      assignmentId: null,
      taskId: null,
      eventType,
      payload,
    },
  };
}

/** A fake SSE `fetch` Response that streams the given wire events then closes. */
function sseResponse(events: WireEvent[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { ok: true, body: stream } as unknown as Response;
}

describe('TurnRunner consultation following', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("opens the consulted agent's stream and renders it to stderr", async () => {
    const rootEvents = [
      audit('root-1', 'state_change', {
        entity: 'agent',
        newStatus: 'paused',
        reason: 'consultation',
        consultedAgentId: 'consulted-1',
        consultedRoleName: 'Accountant',
        question: 'What is the VAT rate?',
      }),
      audit('root-1', 'state_change', {
        entity: 'agent',
        newStatus: 'idle',
        response: 'done',
        reason: 'turn_complete',
      }),
    ];
    const consultedEvents = [
      audit('consulted-1', 'input', { text: 'consulted-agent-marker' }),
    ];
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockImplementation((input) =>
        Promise.resolve(
          sseResponse(
            (typeof input === 'string' ? input : '').endsWith(
              '/api/agent/consulted-1/events',
            )
              ? consultedEvents
              : rootEvents,
          ),
        ),
      );
    mockedApiRequest.mockResolvedValueOnce({ accepted: true });
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const session = new ChatSession(
      { tcpServer: 'http://localhost:3000' },
      'company-1',
      false,
      { token: 'token' },
    );

    await session.runTurn('root-1', 'hello', true);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:3000/api/agent/consulted-1/events',
      expect.anything(),
    );
    const toStderr = stderr.mock.calls.map(([c]) => String(c)).join('');
    const toStdout = stdout.mock.calls.map(([c]) => String(c)).join('');
    expect(toStderr).toContain('consulted-agent-marker');
    expect(toStdout).not.toContain('consulted-agent-marker');
  });
});
