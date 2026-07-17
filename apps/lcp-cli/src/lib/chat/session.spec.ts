import { apiRequest } from '../core/api';
import { readSseStream } from '../core/sse-reader';
import { Tui } from '../tui/tui';
import { ChatSession } from './session';

jest.mock('../core/api');
jest.mock('../core/sse-reader');

const mockedApiRequest = apiRequest as jest.Mock;
const mockedReadSseStream = jest.mocked(readSseStream);

const opts = { lcpServer: 'http://localhost:3000' };

/** A minimal Tui stand-in exposing only the methods ChatSession calls. */
function fakeTui() {
  return {
    appendEvent: jest.fn(),
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
              status: 'succeeded',
              prompt: 'Plan it',
              agentId: 'agent-1',
            },
            {
              id: 'a2',
              roleId: 'role-2',
              status: 'ready',
              prompt: 'Do it',
              agentId: null,
            },
          ],
        })
        .mockResolvedValueOnce([
          { id: 'role-1', name: 'Planner' },
          { id: 'role-2', name: 'Implementer' },
        ]);

      const session = makeSession();
      const { task, assignments } = await session.fetchTaskDetail('task-1');

      expect(task.id).toBe('task-1');
      expect(assignments).toEqual([
        {
          id: 'a1',
          role: 'Planner',
          status: 'succeeded',
          prompt: 'Plan it',
          agentId: 'agent-1',
        },
        {
          id: 'a2',
          role: 'Implementer',
          status: 'ready',
          prompt: 'Do it',
          agentId: null,
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
    it('updates the task pane status on task_changed', () => {
      const tui = fakeTui();
      const session = makeSession(tui);
      session.watchTaskEvents('task-1');

      const onEvent = mockedReadSseStream.mock.calls[0][3];
      onEvent({
        kind: 'task_changed',
        timestamp: 't',
        data: { status: 'succeeded' },
      });

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
              status: 'in-progress',
              prompt: 'x',
              agentId: 'agent-1',
            },
          ],
        })
        .mockResolvedValueOnce([{ id: 'role-1', name: 'Implementer' }]);

      const tui = fakeTui();
      const session = makeSession(tui);
      session.watchTaskEvents('task-1');

      const onEvent = mockedReadSseStream.mock.calls[0][3];
      onEvent({
        kind: 'assignment_changed',
        timestamp: 't',
        data: { id: 'a1', status: 'in-progress' },
      });
      // fetchTaskDetail's promise chain (now one more hop deeper via
      // TokenManager.request) needs a full microtask-queue flush to resolve.
      await new Promise((resolve) => setImmediate(resolve));

      expect(tui.updateTaskPaneAssignments).toHaveBeenCalledWith('task-1', [
        {
          id: 'a1',
          role: 'Implementer',
          status: 'in-progress',
          prompt: 'x',
          agentId: 'agent-1',
        },
      ]);
    });
  });

  describe('stopWatchingTask', () => {
    it('aborts the signal passed to readSseStream', () => {
      const session = makeSession();
      session.watchTaskEvents('task-1');
      const signal = mockedReadSseStream.mock.calls[0][2];
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
          kind: 'agent_status',
          data: { status: 'failed', reason: 'boom' },
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
      const signal = mockedReadSseStream.mock.calls[0][2];

      void session.closeTab('task-1');

      expect(signal.aborted).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('aborts every open task-events watch', async () => {
      const session = makeSession();
      session.watchTaskEvents('task-1');
      session.watchTaskEvents('task-2');
      const signals = mockedReadSseStream.mock.calls.map((call) => call[2]);

      await session.cleanup();

      expect(signals.every((s) => s.aborted)).toBe(true);
    });
  });

  describe('openAssignmentChatPane', () => {
    const assignment = {
      id: 'a1',
      role: 'Implementer',
      status: 'in-progress',
      prompt: 'Write the report',
      agentId: 'agent-1',
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

    it('renders the mapped audit history for a completed agent', async () => {
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
      });
      expect(tui.appendEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ kind: 'response' }),
      );
      expect(tui.switchToPane).toHaveBeenCalledWith('agent-1');
      expect(mockedReadSseStream).not.toHaveBeenCalled();
    });

    it('follows the live SSE stream for a still-running agent', async () => {
      mockedApiRequest.mockResolvedValueOnce({
        id: 'agent-1',
        status: 'running',
      });
      const tui = fakeTui();
      const session = makeSession(tui);

      await session.openAssignmentChatPane(assignment);

      expect(mockedReadSseStream).toHaveBeenCalledWith(
        'http://localhost:3000/api/agent/agent-1/events',
        'token',
        expect.anything(),
        expect.any(Function),
      );
      const onEvent = mockedReadSseStream.mock.calls[0][3];
      onEvent({ kind: 'response', timestamp: 't', data: { delta: 'hi' } });
      expect(tui.appendEvent).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({ kind: 'response' }),
      );
    });
  });
});
