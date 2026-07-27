import type { WireEvent } from '@tcp/shared';
import { apiRequest } from '../core/api';
import { readWireStream } from '../core/sse-reader';
import { Tui } from '../tui/tui';
import { ChatSession } from './session';

jest.mock('../core/api');
jest.mock('../core/sse-reader');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedReadWireStream = jest.mocked(readWireStream);

/** A task/assignment `state_change` WireEvent carrying the given summary. */
function stateChange(
  entity: string,
  payload: Record<string, unknown>,
): WireEvent {
  return {
    type: 'audit',
    event: {
      timestamp: 't',
      companyId: 'c',
      role: 'r',
      agentId: null,
      assignmentId: null,
      taskId: null,
      eventType: 'state_change',
      payload: { entity, ...payload },
    },
  };
}

const opts = { tcpServer: 'http://localhost:3000' };

/** A minimal Tui stand-in exposing only the methods ChatSession calls. */
function fakeTui() {
  return {
    appendEvent: jest.fn(),
    showPaneError: jest.fn(),
    addPane: jest.fn(),
    addTaskPane: jest.fn(),
    hasPane: jest.fn().mockReturnValue(false),
    switchToPane: jest.fn(),
    updateRosterTasks: jest.fn(),
    updateTaskPaneStatus: jest.fn(),
    updateTaskPaneAssignments: jest.fn(),
    setBusy: jest.fn(),
  } as unknown as Tui;
}

function makeSession(tui: Tui | null = null) {
  return new ChatSession(opts, 'company-1', false, tui, { token: 'token' });
}

describe('ChatSession', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  describe('fetchTaskDetail', () => {
    it('resolves each assignment role id to its display name', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          task: {
            id: 'task-1',
            companyId: 'company-1',
            request: 'Do the thing',
            status: 'in-progress',
          },
          assignments: [
            {
              id: 'a1',
              roleId: 'role-1',
              mode: 'plan',
              status: 'succeeded',
              prompt: 'Plan it',
              shortcode: '000-000-plan',
              agentId: 'agent-1',
            },
            {
              id: 'a2',
              roleId: 'role-2',
              mode: 'implement',
              status: 'ready',
              prompt: 'Do it',
              shortcode: '000-001-implement',
              agentId: null,
            },
          ],
        })
        .mockResolvedValueOnce([
          { id: 'role-1', name: 'Planner', slug: 'planner' },
          { id: 'role-2', name: 'Implementer', slug: 'implementer' },
        ]);

      const session = makeSession();
      const { task, assignments } = await session.fetchTaskDetail('task-1');

      expect(task.id).toBe('task-1');
      expect(assignments).toEqual([
        {
          id: 'a1',
          role: 'Planner',
          roleSlug: 'planner',
          mode: 'plan',
          status: 'succeeded',
          prompt: 'Plan it',
          shortcode: '000-000-plan',
          planIndex: 0,
          agentId: 'agent-1',
          failureReason: null,
        },
        {
          id: 'a2',
          role: 'Implementer',
          roleSlug: 'implementer',
          mode: 'implement',
          status: 'ready',
          prompt: 'Do it',
          shortcode: '000-001-implement',
          planIndex: 1,
          agentId: null,
          failureReason: null,
        },
      ]);
      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'GET',
        '/api/company/company-1/roles',
        undefined,
      );
    });
  });

  describe('fetchCompanyDefaultPlannerRoleId', () => {
    it('returns the company plannerRoleId when set', async () => {
      mockedApiRequest.mockResolvedValueOnce({ plannerRoleId: 'role-1' });
      const session = makeSession();

      expect(await session.fetchCompanyDefaultPlannerRoleId()).toBe('role-1');
    });

    it('returns undefined when the company has no default', async () => {
      mockedApiRequest.mockResolvedValueOnce({ plannerRoleId: null });
      const session = makeSession();

      expect(await session.fetchCompanyDefaultPlannerRoleId()).toBeUndefined();
    });
  });

  describe('createTask', () => {
    const submission = {
      companyId: 'company-1',
      request: 'Write a report',
      plannerRoleId: 'role-1',
      expected: [] as string[],
      startImmediately: false,
    };

    it('creates the task without an expected array when none is given', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({ id: 'task-1' }) // POST /api/task
        .mockResolvedValueOnce({
          task: {
            id: 'task-1',
            companyId: 'company-1',
            request: 'Write a report',
            status: 'ready',
          },
          assignments: [],
        })
        .mockResolvedValueOnce([]);
      const session = makeSession();

      const { task } = await session.createTask(submission);

      expect(task.id).toBe('task-1');
      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'POST',
        '/api/task',
        {
          companyId: 'company-1',
          request: 'Write a report',
          plannerRoleId: 'role-1',
        },
      );
    });

    it('includes the expected array when filenames are given', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({ id: 'task-1' })
        .mockResolvedValueOnce({
          task: {
            id: 'task-1',
            companyId: 'company-1',
            request: 'x',
            status: 'ready',
          },
          assignments: [],
        })
        .mockResolvedValueOnce([]);
      const session = makeSession();

      await session.createTask({ ...submission, expected: ['out.md'] });

      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'POST',
        '/api/task',
        expect.objectContaining({
          expected: [{ type: 'task-completed-path', value: 'out.md' }],
        }),
      );
    });

    it('starts the task immediately when requested', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({ id: 'task-1' }) // POST /api/task
        .mockResolvedValueOnce({ id: 'task-1', status: 'planning' }) // POST /api/task/:id/start
        .mockResolvedValueOnce({
          task: {
            id: 'task-1',
            companyId: 'company-1',
            request: 'x',
            status: 'planning',
          },
          assignments: [],
        })
        .mockResolvedValueOnce([]);
      const session = makeSession();

      const { task } = await session.createTask({
        ...submission,
        startImmediately: true,
      });

      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'POST',
        '/api/task/task-1/start',
        undefined,
      );
      expect(task.status).toBe('planning');
    });
  });

  describe('watchTaskEvents', () => {
    it('updates the task pane status on a task state_change', () => {
      const tui = fakeTui();
      const session = makeSession(tui);
      session.watchTaskEvents('task-1');

      const onEvent = mockedReadWireStream.mock.calls[0][3];
      onEvent(stateChange('task', { newStatus: 'succeeded' }));

      expect(tui.updateTaskPaneStatus).toHaveBeenCalledWith(
        'task-1',
        'succeeded',
      );
    });

    it('re-fetches and updates the assignment list on assignment_changed', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({
          task: {
            id: 'task-1',
            companyId: 'company-1',
            request: 'x',
            status: 'in-progress',
          },
          assignments: [
            {
              id: 'a1',
              roleId: 'role-1',
              mode: 'implement',
              status: 'in-progress',
              prompt: 'x',
              shortcode: '000-000-implement',
              agentId: 'agent-1',
            },
          ],
        })
        .mockResolvedValueOnce([
          { id: 'role-1', name: 'Implementer', slug: 'implementer' },
        ]);

      const tui = fakeTui();
      const session = makeSession(tui);
      session.watchTaskEvents('task-1');

      const onEvent = mockedReadWireStream.mock.calls[0][3];
      onEvent(
        stateChange('assignment', {
          assignmentId: 'a1',
          summary: { id: 'a1', status: 'in-progress' },
        }),
      );
      // fetchTaskDetail's promise chain (now one more hop deeper via
      // TokenManager.request) needs a full microtask-queue flush to resolve.
      await new Promise((resolve) => setImmediate(resolve));

      expect(tui.updateTaskPaneAssignments).toHaveBeenCalledWith('task-1', [
        {
          id: 'a1',
          role: 'Implementer',
          roleSlug: 'implementer',
          mode: 'implement',
          status: 'in-progress',
          prompt: 'x',
          shortcode: '000-000-implement',
          planIndex: 0,
          agentId: 'agent-1',
          failureReason: null,
        },
      ]);
    });
  });

  describe('stopWatchingTask', () => {
    it('aborts the signal passed to readSseStream', () => {
      const session = makeSession();
      session.watchTaskEvents('task-1');
      const signal = mockedReadWireStream.mock.calls[0][2];
      expect(signal.aborted).toBe(false);

      session.stopWatchingTask('task-1');

      expect(signal.aborted).toBe(true);
    });
  });

  describe('cancelTask / startTask', () => {
    it('POSTs the cancel endpoint', async () => {
      mockedApiRequest.mockResolvedValueOnce(undefined);
      const session = makeSession();

      await session.cancelTask('task-1');

      expect(mockedApiRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        '/api/task/task-1/cancel',
        undefined,
      );
    });

    it('POSTs the start endpoint', async () => {
      mockedApiRequest.mockResolvedValueOnce(undefined);
      const session = makeSession();

      await session.startTask('task-1');

      expect(mockedApiRequest).toHaveBeenCalledWith(
        expect.anything(),
        'POST',
        '/api/task/task-1/start',
        undefined,
      );
    });

    it('reports the error via reportPaneError on failure, without throwing', async () => {
      mockedApiRequest.mockRejectedValueOnce(new Error('boom'));
      const tui = fakeTui();
      const session = makeSession(tui);

      await session.cancelTask('task-1');

      expect(tui.appendEvent).toHaveBeenCalledWith(
        'task-1',
        expect.objectContaining({
          type: 'audit',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          event: expect.objectContaining({
            eventType: 'state_change',
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            payload: expect.objectContaining({
              entity: 'agent',
              newStatus: 'failed',
              reason: 'boom',
            }),
          }),
        }),
      );
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining('boom'),
      );
    });
  });

  describe('closeTab', () => {
    it('stops watching a closed task panel', () => {
      const session = makeSession();
      session.watchTaskEvents('task-1');
      const signal = mockedReadWireStream.mock.calls[0][2];

      void session.closeTab('task-1');

      expect(signal.aborted).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('aborts every open task-events watch', async () => {
      const session = makeSession();
      session.watchTaskEvents('task-1');
      session.watchTaskEvents('task-2');
      const signals = mockedReadWireStream.mock.calls.map((call) => call[2]);

      await session.cleanup();

      expect(signals.every((s) => s.aborted)).toBe(true);
    });
  });

  describe('openAssignmentChatPane', () => {
    const assignment = {
      id: 'a1',
      role: 'Implementer',
      roleSlug: 'implementer',
      mode: 'implement',
      status: 'in-progress',
      prompt: 'Write the report',
      shortcode: '000-000-implement',
      planIndex: 0,
      agentId: 'agent-1',
      failureReason: null,
    };

    it('does nothing for an assignment with no dispatched agent yet', async () => {
      const tui = fakeTui();
      const session = makeSession(tui);

      await session.openAssignmentChatPane({ ...assignment, agentId: null });

      expect(mockedApiRequest).not.toHaveBeenCalled();
      expect(tui.addPane).not.toHaveBeenCalled();
    });

    it('just switches to the pane if it is already open', async () => {
      const tui = fakeTui();
      (tui.hasPane as jest.Mock).mockReturnValue(true);
      const session = makeSession(tui);

      await session.openAssignmentChatPane(assignment);

      expect(mockedApiRequest).not.toHaveBeenCalled();
      expect(tui.switchToPane).toHaveBeenCalledWith('agent-1');
    });

    it('feeds the audit history rows straight into the pane for a completed agent', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({ id: 'agent-1', status: 'completed' })
        .mockResolvedValueOnce([
          {
            timestamp: 't1',
            eventType: 'llm_response',
            payload: { output: { content: 'The answer.' } },
          },
        ]);
      const tui = fakeTui();
      const session = makeSession(tui);

      await session.openAssignmentChatPane(assignment);

      expect(tui.addPane).toHaveBeenCalledWith({
        id: 'agent-1',
        label: 'Implementer',
        talkable: false,
        roleSlug: 'implementer',
        assignment: {
          id: 'a1',
          shortcode: '000-000-implement',
          status: 'in-progress',
          prompt: 'Write the report',
          failureReason: null,
        },
      });
      expect(tui.appendEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'audit',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          event: expect.objectContaining({ eventType: 'llm_response' }),
        }),
      );
      expect(tui.switchToPane).toHaveBeenCalledWith('agent-1');
      expect(mockedReadWireStream).not.toHaveBeenCalled();
    });

    it('renders history up to now, then follows the live SSE stream, for a still-running agent', async () => {
      mockedApiRequest
        .mockResolvedValueOnce({ id: 'agent-1', status: 'running' })
        .mockResolvedValueOnce([
          {
            timestamp: 't0',
            eventType: 'tool_result',
            payload: {
              output: { kwargs: { name: 'storage__read_working_file' } },
            },
          },
        ]);
      const tui = fakeTui();
      const session = makeSession(tui);

      await session.openAssignmentChatPane(assignment);

      // History was fetched and replayed before the live stream opened.
      expect(mockedApiRequest).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'GET',
        '/api/agent/agent-1/history',
        undefined,
      );
      expect(tui.appendEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'audit',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          event: expect.objectContaining({ eventType: 'tool_result' }),
        }),
      );

      expect(mockedReadWireStream).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent/agent-1/events',
        'token',
        expect.anything(),
        expect.any(Function),
      );
      const onEvent = mockedReadWireStream.mock.calls[0][3];
      const live: WireEvent = {
        type: 'stream',
        agentId: 'agent-1',
        channel: 'response',
        delta: 'hi',
        timestamp: 't',
      };
      onEvent(live);
      expect(tui.appendEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ type: 'stream' }),
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
      const tui = fakeTui();
      const session = makeSession(tui);

      await session.runTurn('agent-1', 'hello', true);

      // The replay event must never surface as a premature empty completion.
      expect(tui.appendEvent).not.toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'stream',
          channel: 'response',
          delta: '',
        }),
      );
      // The real input/terminal events were rendered/used instead.
      expect(tui.appendEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          type: 'audit',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          event: expect.objectContaining({ eventType: 'input' }),
        }),
      );
    });
  });
});
